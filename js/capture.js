/*
* Listens for HTTP request responses, sending first- and
* third-party requests to storage.
*/
const capture = {

  init() {
    this.addListeners();
  },

  addListeners() {
    // listen for each HTTP response
    this.queue = [];
    browser.webRequest.onResponseStarted.addListener((response) => {
      const eventDetails = {
        type: 'sendThirdParty',
        data: response
      };
      this.queue.push(eventDetails);
      this.processNextEvent();
    },
      {urls: ['<all_urls>']});
    // listen for tab updates
    browser.tabs.onUpdated.addListener(
      (tabId, changeInfo, tab) => {
        const eventDetails = {
          type: 'sendFirstParty',
          data: {
            tabId,
            changeInfo,
            tab
          }
        };
        this.queue.push(eventDetails);
        this.processNextEvent();
      });
  },

  // Process each HTTP request or tab page load in order,
  // so that async reads/writes to IndexedDB
  // (via sendFirstParty and sendThirdParty) won't miss data
  // The 'ignore' boolean ensures processNextEvent is only
  // executed when the previous call to processNextEvent
  // has completed.
  async processNextEvent(ignore = false) {
    if (this.processingQueue && !ignore) {
      return;
    }
    if (this.queue.length >= 1) {
      const nextEvent = this.queue.shift();
      this.processingQueue = true;
      switch (nextEvent.type) {
        case 'sendFirstParty':
          await this.sendFirstParty(
            nextEvent.data.tabId,
            nextEvent.data.changeInfo,
            nextEvent.data.tab
          );
          break;
        case 'sendThirdParty':
          await this.sendThirdParty(nextEvent.data);
          break;
        default:
          throw new Error(
            'An event must be of type sendFirstParty or sendThirdParty.'
          );
      }
      this.processNextEvent(true);
    } else {
      this.processingQueue = false;
    }
  },

  // Returns true if the request should be stored, otherwise false.
  // info could be a tab (from setFirstParty) or a
  // response (from setThirdParty) object
  async shouldStore(info) {
    const tabId = info.id || info.tabId;
    let tab, documentUrl, privateBrowsing;
    if (this.isVisibleTab(tabId)) {
      tab = await browser.tabs.get(tabId);
      documentUrl = new URL(tab.url);
      privateBrowsing = tab.incognito;
    } else {
      // browser.tabs.get throws an error for nonvisible tabs (tabId = -1)
      // but some non-visible tabs can make third party requests,
      // ex: Service Workers
      documentUrl = new URL(info.originUrl);
      privateBrowsing = false;
    }
    // ignore about:*, moz-extension:*
    // also ignore private browsing tabs
    if (documentUrl.protocol !== 'about:'
      && documentUrl.protocol !== 'moz-extension:'
      && !privateBrowsing) {
      return true;
    }
    return false;
  },

  isVisibleTab(tabId) {
    return tabId !== browser.tabs.TAB_ID_NONE;
  },

  // capture third party requests
  async sendThirdParty(response) {
    if (!response.originUrl) {
      // originUrl is undefined for the first request from the browser to the
      // first party site
      return;
    }

    // @todo figure out why Web Extensions sometimes gives
    // undefined for response.originUrl
    const originUrl = response.originUrl ? new URL(response.originUrl) : '';
    const targetUrl = new URL(response.url);
    let firstPartyUrl;
    if (this.isVisibleTab(response.tabId)) {
      const tab = await browser.tabs.get(response.tabId);
      firstPartyUrl = new URL(tab.url);
    } else {
      firstPartyUrl = new URL(response.originUrl);
    }

    if (targetUrl.hostname !== firstPartyUrl.hostname
      && await this.shouldStore(response)) {
      let firstPartyUrl;
      if (this.isVisibleTab(response.tabId)) {
        const tab = await browser.tabs.get(response.tabId);
        firstPartyUrl = new URL(tab.url);
      } else {
        firstPartyUrl = new URL(response.originUrl);
      }
      const data = {
        target: targetUrl.hostname,
        origin: originUrl.hostname,
        requestTime: response.timeStamp,
        firstParty: false
      };
      await store.setThirdParty(
        firstPartyUrl.hostname,
        targetUrl.hostname,
        data
      );
    }
  },

  // capture first party requests
  async sendFirstParty(tabId, changeInfo, tab) {
    const documentUrl = new URL(tab.url);
    if (tab.status === 'complete' && await this.shouldStore(tab)) {
      const data = {
        faviconUrl: tab.favIconUrl,
        firstParty: true
      };
      await store.setFirstParty(documentUrl.hostname, data);
    }
  }
};

capture.init();
