import type { Page } from "playwright";

export async function installAssistantMediaCacheMiss(page: Page) {
  await page.addInitScript(() => {
    const nativeFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const cache = init?.cache ?? (input instanceof Request ? input.cache : undefined);
      if (cache === "only-if-cached") {
        const request = new Request(input, init);
        if (new URL(request.url).pathname.endsWith("/__openclaw__/assistant-media")) {
          document.documentElement.dataset.mediaCacheRead = JSON.stringify({
            cache: request.cache,
            mode: request.mode,
            credentials: request.credentials,
          });
          // Playwright routing disables HTTP cache; model its miss without another transport.
          return Promise.reject(new TypeError("HTTP cache unavailable under request routing"));
        }
      }
      return nativeFetch(input, init);
    };
  });
}
