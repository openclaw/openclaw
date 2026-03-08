import { chromium } from "playwright-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as cdpHelpers from "./cdp.helpers.js";
import * as chromeModule from "./chrome.js";
import {
  closePlaywrightBrowserConnection,
  forceDisconnectPlaywrightForTarget,
  getPageForTargetId,
} from "./pw-session.js";

const connectOverCdpSpy = vi.spyOn(chromium, "connectOverCDP");
const getChromeWebSocketUrlSpy = vi.spyOn(chromeModule, "getChromeWebSocketUrl");
const fetchJsonSpy = vi.spyOn(cdpHelpers, "fetchJson");
const withCdpSocketSpy = vi.spyOn(cdpHelpers, "withCdpSocket");

function installMultiPageBrowserMocks() {
  const pageOne = {
    on: vi.fn(),
  } as unknown as import("playwright-core").Page;
  const pageTwo = {
    on: vi.fn(),
  } as unknown as import("playwright-core").Page;

  const context = {
    pages: () => [pageOne, pageTwo],
    on: vi.fn(),
  } as unknown as import("playwright-core").BrowserContext;

  const browserClose = vi.fn(async () => {});
  const browser = {
    contexts: () => [context],
    on: vi.fn(),
    off: vi.fn(),
    close: browserClose,
  } as unknown as import("playwright-core").Browser;

  connectOverCdpSpy.mockResolvedValue(browser);
  getChromeWebSocketUrlSpy.mockResolvedValue(null);

  return { browserClose };
}

afterEach(async () => {
  fetchJsonSpy.mockReset();
  withCdpSocketSpy.mockReset();
  connectOverCdpSpy.mockReset();
  getChromeWebSocketUrlSpy.mockReset();
  await closePlaywrightBrowserConnection().catch(() => {});
});

describe("forceDisconnectPlaywrightForTarget", () => {
  it("keeps a multi-page shared connection alive when target-local termination succeeds", async () => {
    const { browserClose } = installMultiPageBrowserMocks();
    fetchJsonSpy.mockResolvedValue([
      {
        id: "target-1",
        webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/target-1",
      },
    ]);
    withCdpSocketSpy.mockImplementation(async (_wsUrl, work) => {
      await work(async () => ({}));
    });

    await getPageForTargetId({ cdpUrl: "http://127.0.0.1:9222" });
    await forceDisconnectPlaywrightForTarget({
      cdpUrl: "http://127.0.0.1:9222",
      targetId: "target-1",
    });

    expect(browserClose).not.toHaveBeenCalled();
  });

  it("falls back to shared disconnect when target-local termination fails", async () => {
    const { browserClose } = installMultiPageBrowserMocks();
    fetchJsonSpy.mockResolvedValue([
      {
        id: "target-1",
        webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/target-1",
      },
    ]);
    withCdpSocketSpy.mockImplementation(async (_wsUrl, work) => {
      await work(async () => {
        throw new Error("Runtime.terminateExecution unsupported");
      });
    });

    await getPageForTargetId({ cdpUrl: "http://127.0.0.1:9222" });
    await forceDisconnectPlaywrightForTarget({
      cdpUrl: "http://127.0.0.1:9222",
      targetId: "target-1",
    });

    expect(browserClose).toHaveBeenCalledTimes(1);
  });
});
