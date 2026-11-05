/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isNativeEmbedHost,
  isNativeMobileHost,
  setNativeControlHost,
  nativeEmbedHost,
  isNativeWebChromeHost,
  readNativeHistoryState,
} from "./native-web-chrome.ts";

type TestNativeWindow = Window & {
  __OPENCLAW_NATIVE_WEB_CHROME__?: boolean;
  __OPENCLAW_NATIVE_HISTORY__?: { canGoBack: boolean; canGoForward: boolean };
};

afterEach(() => {
  setNativeControlHost(false);
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, "maxTouchPoints");
  Reflect.deleteProperty(window, "__OPENCLAW_NATIVE_WEB_CHROME__");
  Reflect.deleteProperty(window, "__OPENCLAW_NATIVE_HISTORY__");
  Reflect.deleteProperty(window, "__OPENCLAW_NATIVE_EMBED__");
});

describe("native web chrome capability", () => {
  it.each([
    ["iPhone", "iPhone", 1, true],
    ["Android", "Linux armv8l", 1, true],
    ["Macintosh", "MacIntel", 5, true],
    ["Macintosh", "MacIntel", 0, false],
    ["Windows", "Win32", 1, false],
  ])(
    "requires native provenance for %s (%s, %i touch points)",
    (userAgent, platform, touches, mobile) => {
      vi.spyOn(navigator, "userAgent", "get").mockReturnValue(userAgent);
      vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
      Object.defineProperty(navigator, "maxTouchPoints", { value: touches, configurable: true });
      expect(isNativeMobileHost()).toBe(false);
      setNativeControlHost(true);
      expect(isNativeMobileHost()).toBe(mobile);
    },
  );

  it.each(["ios", "android", "macos"])(
    "uses the explicit %s host platform, not window width",
    (platform) => {
      Object.assign(window, { __OPENCLAW_NATIVE_EMBED__: { platform, formFactor: "desktop" } });
      expect(isNativeMobileHost()).toBe(platform !== "macos");
    },
  );

  it.each([
    null,
    true,
    [],
    {},
    { platform: "ios" },
    { platform: "web", formFactor: "phone" },
    { platform: "ios", formFactor: "watch" },
    { platform: "macos", formFactor: "desktop", surface: "unknown" },
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
  it("accepts the conversation surface", () => {
    const host = { platform: "macos", formFactor: "desktop", surface: "conversation" };
    Object.assign(window, { __OPENCLAW_NATIVE_EMBED__: host });
    expect(nativeEmbedHost()).toEqual(host);
  });

  it("requires the document-start capability flag", () => {
    expect(isNativeWebChromeHost()).toBe(false);
    (window as TestNativeWindow)["__OPENCLAW_NATIVE_WEB_CHROME__"] = true;
    expect(isNativeWebChromeHost()).toBe(true);
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
