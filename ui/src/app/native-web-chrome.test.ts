/* @vitest-environment jsdom */

import { afterEach, describe, expect, it } from "vitest";
import {
  isOwnedControlUiServiceWorkerRegistration,
  isNativeEmbedHost,
  nativeEmbedHost,
  isNativeWebChromeHost,
  readNativeHistoryState,
  shouldRegisterControlUiServiceWorker,
} from "./native-web-chrome.ts";
import { inferControlUiPublicAssetPath } from "./public-assets.ts";

type TestNativeWindow = Window & {
  __OPENCLAW_NATIVE_WEB_CHROME__?: boolean;
  __OPENCLAW_NATIVE_HISTORY__?: { canGoBack: boolean; canGoForward: boolean };
};

afterEach(() => {
  Reflect.deleteProperty(window, "__OPENCLAW_NATIVE_WEB_CHROME__");
  Reflect.deleteProperty(window, "__OPENCLAW_NATIVE_CONTROL_UI_CACHE_POLICY__");
  Reflect.deleteProperty(window, "__OPENCLAW_NATIVE_HISTORY__");
  Reflect.deleteProperty(window, "__OPENCLAW_NATIVE_EMBED__");
});

describe("native web chrome capability", () => {
  it.each([
    null,
    true,
    [],
    {},
    { platform: "ios" },
    { platform: "web", formFactor: "phone" },
    { platform: "ios", formFactor: "watch" },
  ])("rejects malformed embed hosts: %j", (host) => {
    Object.assign(window, { __OPENCLAW_NATIVE_EMBED__: host });
    expect(isNativeEmbedHost()).toBe(false);
    expect(nativeEmbedHost()).toBeNull();
  });

  it.each(["ios", "macos", "android"] as const)(
    "reads explicit %s embed capabilities without enabling web chrome",
    (platform) => {
      for (const formFactor of ["phone", "pad", "desktop"] as const) {
        const host = { platform, formFactor };
        Object.assign(window, { __OPENCLAW_NATIVE_EMBED__: host });
        expect(nativeEmbedHost()).toEqual(host);
        expect(isNativeEmbedHost()).toBe(true);
        expect(isNativeWebChromeHost()).toBe(false);
      }
    },
  );
  it("requires the document-start capability flag", () => {
    expect(isNativeWebChromeHost()).toBe(false);
    (window as TestNativeWindow)["__OPENCLAW_NATIVE_WEB_CHROME__"] = true;
    expect(isNativeWebChromeHost()).toBe(true);
  });

  it.each([
    [false, false],
    [true, true],
  ] as const)(
    "registers the service worker only for production browser hosts: %j",
    (isProd, expected) => {
      expect(shouldRegisterControlUiServiceWorker(isProd)).toBe(expected);
      (window as TestNativeWindow)["__OPENCLAW_NATIVE_WEB_CHROME__"] = true;
      expect(shouldRegisterControlUiServiceWorker(isProd)).toBe(expected);
      Object.assign(window, {
        __OPENCLAW_NATIVE_CONTROL_UI_CACHE_POLICY__: "reload",
      });
      expect(shouldRegisterControlUiServiceWorker(isProd)).toBe(false);
      Object.assign(window, {
        __OPENCLAW_NATIVE_CONTROL_UI_CACHE_POLICY__: undefined,
      });
      expect(shouldRegisterControlUiServiceWorker(isProd)).toBe(expected);
      Reflect.deleteProperty(window, "__OPENCLAW_NATIVE_WEB_CHROME__");
    },
  );

  it.each([
    ["owned Control UI worker", "http://127.0.0.1:18789/sw.js", "/", true],
    ["worker outside the Control UI scope", "http://127.0.0.1:18789/sw.js", "/other/", false],
    ["unrelated same-origin worker", "http://127.0.0.1:18789/other-sw.js", "/", false],
    ["cross-origin worker", "https://example.test/sw.js", "/", false],
  ] as const)("identifies %s", (_label, scriptUrl, scopePath, expected) => {
    const registration = {
      scope: `http://127.0.0.1:18789${scopePath}`,
      installing: null,
      waiting: null,
      active: { scriptURL: scriptUrl },
    } as unknown as ServiceWorkerRegistration;
    expect(
      isOwnedControlUiServiceWorkerRegistration(
        registration,
        new URL("http://127.0.0.1:18789/sw.js"),
        new URL("http://127.0.0.1:18789/chat"),
      ),
    ).toBe(expected);
  });

  it("identifies the owned worker under an inferred custom base path", () => {
    const pageUrl = new URL("http://127.0.0.1:18789/apps/openclaw/chat");
    const registration = {
      scope: "http://127.0.0.1:18789/apps/openclaw/",
      installing: null,
      waiting: null,
      active: { scriptURL: "http://127.0.0.1:18789/apps/openclaw/sw.js?v=old-build" },
    } as unknown as ServiceWorkerRegistration;
    const controlUiWorkerUrl = new URL(
      inferControlUiPublicAssetPath("sw.js", { pathname: pageUrl.pathname }),
      pageUrl.origin,
    );
    expect(
      isOwnedControlUiServiceWorkerRegistration(registration, controlUiWorkerUrl, pageUrl),
    ).toBe(true);
  });

  it("reads native history state and defaults safely", () => {
    expect(readNativeHistoryState()).toEqual({ canGoBack: false, canGoForward: false });
    (window as TestNativeWindow)["__OPENCLAW_NATIVE_HISTORY__"] = {
      canGoBack: true,
      canGoForward: false,
    };
    expect(readNativeHistoryState()).toEqual({ canGoBack: true, canGoForward: false });
  });
});
