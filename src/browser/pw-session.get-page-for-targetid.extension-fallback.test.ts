import { chromium } from "playwright-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as chromeModule from "./chrome.js";
import { closePlaywrightBrowserConnection, getPageForTargetId } from "./pw-session.js";

const connectOverCdpSpy = vi.spyOn(chromium, "connectOverCDP");
const getChromeWebSocketUrlSpy = vi.spyOn(chromeModule, "getChromeWebSocketUrl");

afterEach(async () => {
  connectOverCdpSpy.mockClear();
  getChromeWebSocketUrlSpy.mockClear();
  await closePlaywrightBrowserConnection().catch(() => {});
});

describe("pw-session getPageForTargetId", () => {
  it("falls back to the only page when CDP session attachment is blocked (extension relays)", async () => {
    connectOverCdpSpy.mockClear();
    getChromeWebSocketUrlSpy.mockClear();

    const pageOn = vi.fn();
    const contextOn = vi.fn();
    const browserOn = vi.fn();
    const browserClose = vi.fn(async () => {});

    const context = {
      pages: () => [],
      on: contextOn,
      newCDPSession: vi.fn(async () => {
        throw new Error("Not allowed");
      }),
    } as unknown as import("playwright-core").BrowserContext;

    const page = {
      on: pageOn,
      context: () => context,
    } as unknown as import("playwright-core").Page;

    // Fill pages() after page exists.
    (context as unknown as { pages: () => unknown[] }).pages = () => [page];

    const browser = {
      contexts: () => [context],
      on: browserOn,
      close: browserClose,
    } as unknown as import("playwright-core").Browser;

    connectOverCdpSpy.mockResolvedValue(browser);
    getChromeWebSocketUrlSpy.mockResolvedValue(null);

    const resolved = await getPageForTargetId({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "NOT_A_TAB",
    });
    expect(resolved).toBe(page);

    await closePlaywrightBrowserConnection();
    expect(browserClose).toHaveBeenCalled();
  });

  it("uses the shared HTTP-base normalization when falling back to /json/list for direct WebSocket CDP URLs", async () => {
    const pageOn = vi.fn();
    const contextOn = vi.fn();
    const browserOn = vi.fn();
    const browserClose = vi.fn(async () => {});

    const context = {
      pages: () => [],
      on: contextOn,
      newCDPSession: vi.fn(async () => {
        throw new Error("Not allowed");
      }),
    } as unknown as import("playwright-core").BrowserContext;

    const pageA = {
      on: pageOn,
      context: () => context,
      url: () => "https://alpha.example",
    } as unknown as import("playwright-core").Page;
    const pageB = {
      on: pageOn,
      context: () => context,
      url: () => "https://beta.example",
    } as unknown as import("playwright-core").Page;

    (context as unknown as { pages: () => unknown[] }).pages = () => [pageA, pageB];

    const browser = {
      contexts: () => [context],
      on: browserOn,
      close: browserClose,
    } as unknown as import("playwright-core").Browser;

    connectOverCdpSpy.mockResolvedValue(browser);
    getChromeWebSocketUrlSpy.mockResolvedValue(null);

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => [
        { id: "TARGET_A", url: "https://alpha.example" },
        { id: "TARGET_B", url: "https://beta.example" },
      ],
    } as Response);

    try {
      const resolved = await getPageForTargetId({
        cdpUrl: "ws://127.0.0.1:18792/devtools/browser/SESSION?token=abc",
        targetId: "TARGET_B",
      });
      expect(resolved).toBe(pageB);
      expect(fetchSpy).toHaveBeenCalledWith(
        "http://127.0.0.1:18792/json/list?token=abc",
        expect.any(Object),
      );
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("resolves extension-relay pages from /json/list without probing page CDP sessions first", async () => {
    const pageOn = vi.fn();
    const contextOn = vi.fn();
    const browserOn = vi.fn();
    const browserClose = vi.fn(async () => {});
    const newCDPSession = vi.fn(async () => {
      throw new Error("Target.attachToBrowserTarget: Not allowed");
    });

    const context = {
      pages: () => [],
      on: contextOn,
      newCDPSession,
    } as unknown as import("playwright-core").BrowserContext;

    const pageA = {
      on: pageOn,
      context: () => context,
      url: () => "https://alpha.example",
    } as unknown as import("playwright-core").Page;
    const pageB = {
      on: pageOn,
      context: () => context,
      url: () => "https://beta.example",
    } as unknown as import("playwright-core").Page;

    (context as unknown as { pages: () => unknown[] }).pages = () => [pageA, pageB];

    const browser = {
      contexts: () => [context],
      on: browserOn,
      close: browserClose,
    } as unknown as import("playwright-core").Browser;

    connectOverCdpSpy.mockResolvedValue(browser);
    getChromeWebSocketUrlSpy.mockResolvedValue(null);

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ Browser: "OpenClaw/extension-relay" }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          { id: "TARGET_A", url: "https://alpha.example" },
          { id: "TARGET_B", url: "https://beta.example" },
        ],
      } as Response);

    try {
      const resolved = await getPageForTargetId({
        cdpUrl: "http://127.0.0.1:19993",
        targetId: "TARGET_B",
      });
      expect(resolved).toBe(pageB);
      expect(newCDPSession).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
