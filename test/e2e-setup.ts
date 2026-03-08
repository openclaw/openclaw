/**
 * E2E Test Setup - Mock browser globals for Node.js environment
 *
 * This file runs before any e2e tests to set up browser APIs that the UI
 * modules depend on (localStorage, navigator, etc.).
 *
 * This is separate from test/setup.ts which is for the main test suite.
 */

// Mock localStorage for browser-only modules (i18n)
const localStorageStore: Record<string, string> = {};

if (typeof localStorage === "undefined") {
  (globalThis as { localStorage: Storage }).localStorage = {
    getItem: (key: string) => localStorageStore[key] ?? null,
    setItem: (key: string, value: string) => {
      localStorageStore[key] = value;
    },
    removeItem: (key: string) => {
      delete localStorageStore[key];
    },
    clear: () => {
      for (const key of Object.keys(localStorageStore)) {
        delete localStorageStore[key];
      }
    },
    get length() {
      return Object.keys(localStorageStore).length;
    },
    key: (index: number) => Object.keys(localStorageStore)[index] ?? null,
  };
}

// Mock navigator for browser-only modules (i18n)
if (typeof navigator === "undefined") {
  (globalThis as { navigator: { language: string } }).navigator = {
    language: "en-US",
  };
}
