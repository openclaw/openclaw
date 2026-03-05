import { chromium } from "playwright-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as chromeModule from "./chrome.js";
import { InvalidBrowserNavigationUrlError } from "./navigation-guard.js";
import { closePlaywrightBrowserConnection, createPageViaPlaywright } from "./pw-session.js";

const connectOverCdpSpy = vi.spyOn(chromium, "connectOverCDP");
const getChromeWebSocketUrlSpy = vi.spyOn(chromeModule, "getChromeWebSocketUrl");

function installBrowserMocks() {
  const pageOn = vi.fn();
  const pageGoto = vi.fn(async () => {});
  const pageTitle = vi.fn(async () => "");
  const pageUrl = vi.fn(() => "about:blank");
  const contextOn = vi.fn();
  const browserOn = vi.fn();
  const browserClose = vi.fn(async () => {});
  const sessionSend = vi.fn(async (method: string) => {
    if (method === "Target.getTargetInfo") {
      return { targetInfo: { targetId: "TARGET_1" } };
    }
    return {};
  });
  const sessionDetach = vi.fn(async () => {});

  const context = {
    pages: () => [],
    on: contextOn,
    newPage: vi.fn(async () => page),
    newCDPSession: vi.fn(async () => ({
      send: sessionSend,
      detach: sessionDetach,
    })),
  } as unknown as import("playwright-core").BrowserContext;

  const page = {
    on: pageOn,
    context: () => context,
    goto: pageGoto,
    title: pageTitle,
    url: pageUrl,
  } as unknown as import("playwright-core").Page;

  const browser = {
    contexts: () => [context],
    on: browserOn,
    close: browserClose,
  } as unknown as import("playwright-core").Browser;

  connectOverCdpSpy.mockResolvedValue(browser);
  getChromeWebSocketUrlSpy.mockResolvedValue(null);

  return { pageGoto, browserClose };
}

afterEach(async () => {
  connectOverCdpSpy.mockClear();
  getChromeWebSocketUrlSpy.mockClear();
  await closePlaywrightBrowserConnection().catch(() => {});
});

describe("pw-session createPageViaPlaywright navigation guard", () => {
  it("blocks unsupported non-network URLs", async () => {
    const { pageGoto } = installBrowserMocks();

    await expect(
      createPageViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        url: "file:///etc/passwd",
      }),
    ).rejects.toBeInstanceOf(InvalidBrowserNavigationUrlError);

    expect(pageGoto).not.toHaveBeenCalled();
  });

  it("allows about:blank without network navigation", async () => {
    const { pageGoto } = installBrowserMocks();

    const created = await createPageViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      url: "about:blank",
    });

    expect(created.targetId).toBe("TARGET_1");
    expect(pageGoto).not.toHaveBeenCalled();
  });
});
