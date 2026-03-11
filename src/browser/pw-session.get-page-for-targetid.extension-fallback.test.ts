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

function fetchInputToUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  if (input instanceof Request) {
    return input.url;
  }
  return "";
}

function mockRelayFetch(opts: {
  targets: Array<{ id: string; url: string; title?: string }>;
  aliases?: Record<string, string>;
}) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
    const raw = fetchInputToUrl(url);
    if (raw.includes("/json/version")) {
      return {
        ok: true,
        json: async () => ({ Browser: "OpenClaw/extension-relay" }),
      } as Response;
    }
    const resolveMatch = raw.match(/\/json\/resolve\/([^/?#]+)/);
    if (resolveMatch) {
      const requested = decodeURIComponent(resolveMatch[1] ?? "");
      const mapped = opts.aliases?.[requested];
      if (!mapped) {
        return {
          ok: false,
          status: 404,
          json: async () => ({}),
        } as Response;
      }
      return {
        ok: true,
        json: async () => ({ targetId: mapped }),
      } as Response;
    }
    if (raw.includes("/json/list")) {
      return {
        ok: true,
        json: async () => opts.targets,
      } as Response;
    }
    throw new Error(`unexpected fetch url: ${raw}`);
  });
}

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
    const fetchSpy = mockRelayFetch({
      targets: [{ id: "SOME_OTHER_TAB", url: "https://other.example" }],
    });

    try {
      const resolved = await getPageForTargetId({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "NOT_A_TAB",
      });
      expect(resolved).toBe(page);

      await closePlaywrightBrowserConnection();
      expect(browserClose).toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
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
    const fetchSpy = mockRelayFetch({
      targets: [
        { id: "TARGET_A", url: "https://alpha.example" },
        { id: "TARGET_B", url: "https://beta.example" },
      ],
    });

    try {
      const resolved = await getPageForTargetId({
        cdpUrl: "ws://127.0.0.1:18792/devtools/browser/SESSION?token=abc",
        targetId: "TARGET_B",
      });
      expect(resolved).toBe(pageB);
      expect(
        fetchSpy.mock.calls.some((args) =>
          fetchInputToUrl(args[0]).includes("/json/list?token=abc"),
        ),
      ).toBe(true);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("resolves stale extension target ids through /json/resolve", async () => {
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
    const fetchSpy = mockRelayFetch({
      targets: [
        { id: "TARGET_A", url: "https://alpha.example" },
        { id: "TARGET_B", url: "https://beta.example" },
      ],
      aliases: { OLD_TARGET: "TARGET_B" },
    });

    try {
      const resolved = await getPageForTargetId({
        cdpUrl: "http://127.0.0.1:19993",
        targetId: "OLD_TARGET",
      });
      expect(resolved).toBe(pageB);
      expect(
        fetchSpy.mock.calls.some((args) =>
          fetchInputToUrl(args[0]).includes("/json/resolve/OLD_TARGET"),
        ),
      ).toBe(true);
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
    const fetchSpy = mockRelayFetch({
      targets: [
        { id: "TARGET_A", url: "https://alpha.example" },
        { id: "TARGET_B", url: "https://beta.example" },
      ],
    });

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

  it("handles duplicate-URL count skew between relay list and Playwright pages", async () => {
    const pageOn = vi.fn();
    const contextOn = vi.fn();
    const browserOn = vi.fn();
    const browserClose = vi.fn(async () => {});
    const newCDPSession = vi.fn(async () => {
      throw new Error("Not allowed");
    });

    const context = {
      pages: () => [],
      on: contextOn,
      newCDPSession,
    } as unknown as import("playwright-core").BrowserContext;

    const pageA = {
      on: pageOn,
      context: () => context,
      url: () => "https://e-services.empower.ae/",
    } as unknown as import("playwright-core").Page;
    const pageB = {
      on: pageOn,
      context: () => context,
      url: () => "https://e-services.empower.ae/",
    } as unknown as import("playwright-core").Page;
    const pageC = {
      on: pageOn,
      context: () => context,
      url: () => "https://e-services.empower.ae/",
    } as unknown as import("playwright-core").Page;
    (context as unknown as { pages: () => unknown[] }).pages = () => [pageA, pageB, pageC];

    const browser = {
      contexts: () => [context],
      on: browserOn,
      close: browserClose,
    } as unknown as import("playwright-core").Browser;

    connectOverCdpSpy.mockResolvedValue(browser);
    getChromeWebSocketUrlSpy.mockResolvedValue(null);
    const fetchSpy = mockRelayFetch({
      targets: [
        { id: "TARGET_A", url: "https://e-services.empower.ae/" },
        { id: "TARGET_B", url: "https://e-services.empower.ae/" },
      ],
    });

    try {
      const resolved = await getPageForTargetId({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "TARGET_B",
      });
      expect(resolved).toBe(pageB);
      expect(newCDPSession).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("keeps continuity when relay lists target but page mapping temporarily misses", async () => {
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
      url: () => "about:blank",
      evaluate: vi.fn(async () => false),
      title: vi.fn(async () => ""),
    } as unknown as import("playwright-core").Page;
    const pageB = {
      on: pageOn,
      context: () => context,
      url: () => "about:blank",
      evaluate: vi.fn(async () => false),
      title: vi.fn(async () => ""),
    } as unknown as import("playwright-core").Page;
    (context as unknown as { pages: () => unknown[] }).pages = () => [pageA, pageB];

    const browser = {
      contexts: () => [context],
      on: browserOn,
      close: browserClose,
    } as unknown as import("playwright-core").Browser;

    connectOverCdpSpy.mockResolvedValue(browser);
    getChromeWebSocketUrlSpy.mockResolvedValue(null);
    const fetchSpy = mockRelayFetch({
      targets: [{ id: "TARGET_STILL_LISTED", url: "https://e-services.empower.ae/Login" }],
    });

    try {
      const resolved = await getPageForTargetId({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "TARGET_STILL_LISTED",
      });
      expect(resolved).toBe(pageA);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
