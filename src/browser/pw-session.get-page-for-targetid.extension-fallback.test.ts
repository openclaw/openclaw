import { afterEach, describe, expect, it, vi } from "vitest";

const extensionRelayMocks = vi.hoisted(() => ({
  getChromeExtensionRelayAuthHeaders: vi.fn(() => ({})),
}));

vi.mock("./extension-relay.js", () => extensionRelayMocks);

const { chromium } = await import("playwright-core");
const chromeModule = await import("./chrome.js");
const { closePlaywrightBrowserConnection, getPageForTargetId } = await import("./pw-session.js");

const connectOverCdpSpy = vi.spyOn(chromium, "connectOverCDP");
const getChromeWebSocketUrlSpy = vi.spyOn(chromeModule, "getChromeWebSocketUrl");

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
}

afterEach(async () => {
  connectOverCdpSpy.mockClear();
  getChromeWebSocketUrlSpy.mockClear();
  extensionRelayMocks.getChromeExtensionRelayAuthHeaders.mockReset();
  extensionRelayMocks.getChromeExtensionRelayAuthHeaders.mockReturnValue({});
  await closePlaywrightBrowserConnection().catch(() => {});
});

function createExtensionFallbackBrowserHarness(options?: {
  urls?: string[];
  newCDPSessionError?: string;
  emulateMediaImplementations?: Array<() => Promise<void>>;
}) {
  const pageOn = vi.fn();
  const contextOn = vi.fn();
  const browserOn = vi.fn();
  const browserClose = vi.fn(async () => {});
  const newCDPSession = vi.fn(async () => {
    throw new Error(options?.newCDPSessionError ?? "Not allowed");
  });

  const context = {
    pages: () => [],
    on: contextOn,
    newCDPSession,
  } as unknown as import("playwright-core").BrowserContext;

  const pageEmulateMediaSpies: Array<ReturnType<typeof vi.fn>> = [];
  const pages = (options?.urls ?? [undefined]).map((url, index) => {
    const emulateMedia = vi.fn(options?.emulateMediaImplementations?.[index] ?? (async () => {}));
    pageEmulateMediaSpies.push(emulateMedia);
    return {
      on: pageOn,
      context: () => context,
      emulateMedia,
      ...(url ? { url: () => url } : {}),
    } as unknown as import("playwright-core").Page;
  });
  (context as unknown as { pages: () => unknown[] }).pages = () => pages;

  const browser = {
    contexts: () => [context],
    on: browserOn,
    close: browserClose,
  } as unknown as import("playwright-core").Browser;

  connectOverCdpSpy.mockResolvedValue(browser);
  getChromeWebSocketUrlSpy.mockResolvedValue(null);
  return { browserClose, newCDPSession, pageEmulateMediaSpies, pages };
}

describe("pw-session getPageForTargetId", () => {
  it("retries when the browser disconnects before the initial relay setup finishes", async () => {
    const pageOn = vi.fn();
    const contextOn = vi.fn();
    const firstBrowserOn = vi.fn();
    const firstBrowserOff = vi.fn();
    const secondBrowserOn = vi.fn();
    const secondBrowserOff = vi.fn();
    const firstBrowserClose = vi.fn(async () => {});
    const secondBrowserClose = vi.fn(async () => {});
    const deferredVersion = createDeferred<Response>();

    const firstContext = {
      pages: () => [],
      on: contextOn,
      newCDPSession: vi.fn(async () => {
        throw new Error("Not allowed");
      }),
    } as unknown as import("playwright-core").BrowserContext;
    const firstPageEmulateMedia = vi.fn(async () => {});
    const firstPage = {
      on: pageOn,
      context: () => firstContext,
      url: () => "https://alpha.example",
      emulateMedia: firstPageEmulateMedia,
    } as unknown as import("playwright-core").Page;
    (firstContext as unknown as { pages: () => unknown[] }).pages = () => [firstPage];

    const secondContext = {
      pages: () => [],
      on: contextOn,
      newCDPSession: vi.fn(async () => {
        throw new Error("Not allowed");
      }),
    } as unknown as import("playwright-core").BrowserContext;
    const secondPageEmulateMedia = vi.fn(async () => {});
    const secondPage = {
      on: pageOn,
      context: () => secondContext,
      url: () => "https://beta.example",
      emulateMedia: secondPageEmulateMedia,
    } as unknown as import("playwright-core").Page;
    (secondContext as unknown as { pages: () => unknown[] }).pages = () => [secondPage];

    let firstDisconnectedHandler: (() => void) | undefined;
    const firstBrowser = {
      contexts: () => [firstContext],
      on: firstBrowserOn.mockImplementation((event: string, handler: () => void) => {
        if (event === "disconnected") {
          firstDisconnectedHandler = handler;
        }
      }),
      off: firstBrowserOff,
      close: firstBrowserClose,
    } as unknown as import("playwright-core").Browser;
    const secondBrowser = {
      contexts: () => [secondContext],
      on: secondBrowserOn,
      off: secondBrowserOff,
      close: secondBrowserClose,
    } as unknown as import("playwright-core").Browser;

    connectOverCdpSpy.mockResolvedValueOnce(firstBrowser).mockResolvedValueOnce(secondBrowser);
    getChromeWebSocketUrlSpy.mockResolvedValue(null);

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockReturnValueOnce(deferredVersion.promise).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ Browser: "OpenClaw/extension-relay" }),
    } as Response);

    const pending = getPageForTargetId({
      cdpUrl: "http://127.0.0.1:19994",
    });

    await vi.waitFor(() => {
      expect(firstBrowserOn).toHaveBeenCalledWith("disconnected", expect.any(Function));
    });
    firstDisconnectedHandler?.();
    deferredVersion.resolve({
      ok: true,
      json: async () => ({ Browser: "OpenClaw/extension-relay" }),
    } as Response);

    try {
      const resolved = await pending;
      expect(resolved).toBe(secondPage);
      expect(connectOverCdpSpy).toHaveBeenCalledTimes(2);
      expect(firstBrowserOff).toHaveBeenCalledWith("disconnected", expect.any(Function));
      expect(secondPageEmulateMedia).toHaveBeenCalledWith({ colorScheme: null });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("falls back to the only page when CDP session attachment is blocked (extension relays)", async () => {
    const { browserClose, pages } = createExtensionFallbackBrowserHarness();
    const [page] = pages;

    const resolved = await getPageForTargetId({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "NOT_A_TAB",
    });
    expect(resolved).toBe(page);

    await closePlaywrightBrowserConnection();
    expect(browserClose).toHaveBeenCalled();
  });

  it("does not let one stuck page block initial relay setup for other attached pages", async () => {
    vi.useFakeTimers();
    const { pageEmulateMediaSpies, pages } = createExtensionFallbackBrowserHarness({
      urls: ["https://alpha.example", "https://beta.example"],
      emulateMediaImplementations: [() => new Promise(() => {}), async () => {}],
    });
    const [, pageB] = pages;

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
      const pending = getPageForTargetId({
        cdpUrl: "http://127.0.0.1:19995",
        targetId: "TARGET_B",
      });
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1_001);

      await expect(pending).resolves.toBe(pageB);
      expect(pageEmulateMediaSpies[0]).toHaveBeenCalledWith({ colorScheme: null });
      expect(pageEmulateMediaSpies[1]).toHaveBeenCalledWith({ colorScheme: null });
    } finally {
      fetchSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("does not re-queue single-page relay neutralization while a timed-out attempt is still stuck", async () => {
    vi.useFakeTimers();
    extensionRelayMocks.getChromeExtensionRelayAuthHeaders.mockReturnValue({
      "x-openclaw-relay-token": "test-token",
    });
    const { pageEmulateMediaSpies, pages } = createExtensionFallbackBrowserHarness({
      urls: ["https://alpha.example"],
      emulateMediaImplementations: [() => new Promise(() => {})],
    });
    const [page] = pages;

    try {
      const pending = getPageForTargetId({
        cdpUrl: "http://127.0.0.1:19998",
      });
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1_001);

      await expect(pending).resolves.toBe(page);
      expect(pageEmulateMediaSpies[0]).toHaveBeenCalledTimes(1);
      expect(pageEmulateMediaSpies[0]).toHaveBeenNthCalledWith(1, { colorScheme: null });
    } finally {
      vi.useRealTimers();
    }
  });

  it("applies a cooldown before retrying relay neutralization after a timeout", async () => {
    vi.useFakeTimers();
    extensionRelayMocks.getChromeExtensionRelayAuthHeaders.mockReturnValue({
      "x-openclaw-relay-token": "test-token",
    });
    let callCount = 0;
    const { pageEmulateMediaSpies, pages } = createExtensionFallbackBrowserHarness({
      urls: ["https://alpha.example"],
      emulateMediaImplementations: [
        () => {
          callCount += 1;
          if (callCount === 1) {
            return new Promise<void>((_resolve, reject) => {
              setTimeout(() => reject(new Error("late failure")), 2_000);
            });
          }
          return Promise.resolve();
        },
      ],
    });
    const [page] = pages;

    try {
      const first = getPageForTargetId({
        cdpUrl: "http://127.0.0.1:19999",
      });
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1_001);

      await expect(first).resolves.toBe(page);
      expect(pageEmulateMediaSpies[0]).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1_000);

      await expect(
        getPageForTargetId({
          cdpUrl: "http://127.0.0.1:19999",
        }),
      ).resolves.toBe(page);
      expect(pageEmulateMediaSpies[0]).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(4_000);

      await expect(
        getPageForTargetId({
          cdpUrl: "http://127.0.0.1:19999",
        }),
      ).resolves.toBe(page);
      expect(pageEmulateMediaSpies[0]).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps relay appearance neutralization when relay probing transiently fails but auth hint exists", async () => {
    extensionRelayMocks.getChromeExtensionRelayAuthHeaders.mockReturnValue({
      "x-openclaw-relay-token": "test-token",
    });
    const { newCDPSession, pageEmulateMediaSpies, pages } = createExtensionFallbackBrowserHarness({
      urls: ["https://alpha.example", "https://beta.example"],
      newCDPSessionError: "Target.attachToBrowserTarget: Not allowed",
    });
    const [, pageB] = pages;

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockRejectedValueOnce(new Error("timeout")).mockResolvedValueOnce({
      ok: true,
      json: async () => [
        { id: "TARGET_A", url: "https://alpha.example" },
        { id: "TARGET_B", url: "https://beta.example" },
      ],
    } as Response);

    try {
      const resolved = await getPageForTargetId({
        cdpUrl: "http://127.0.0.1:19997",
        targetId: "TARGET_B",
      });
      expect(resolved).toBe(pageB);
      expect(newCDPSession).toHaveBeenCalled();
      expect(pageEmulateMediaSpies[1]).toHaveBeenCalledWith({ colorScheme: null });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("uses the shared HTTP-base normalization when falling back to /json/list for direct WebSocket CDP URLs", async () => {
    const [, pageB] = createExtensionFallbackBrowserHarness({
      urls: ["https://alpha.example", "https://beta.example"],
    }).pages;

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
    const { newCDPSession, pageEmulateMediaSpies, pages } = createExtensionFallbackBrowserHarness({
      urls: ["https://alpha.example", "https://beta.example"],
      newCDPSessionError: "Target.attachToBrowserTarget: Not allowed",
    });
    const [, pageB] = pages;

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
      expect(pageEmulateMediaSpies[0]).toHaveBeenCalledWith({ colorScheme: null });
      expect(pageEmulateMediaSpies[1]).toHaveBeenCalledWith({ colorScheme: null });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("does not cache a relay browser after it was closed during initial setup", async () => {
    const deferredNeutralization = createDeferred<void>();
    const firstHarness = createExtensionFallbackBrowserHarness({
      urls: ["https://alpha.example"],
      emulateMediaImplementations: [() => deferredNeutralization.promise],
    });

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ Browser: "OpenClaw/extension-relay" }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ Browser: "OpenClaw/extension-relay" }),
      } as Response);

    try {
      const pending = getPageForTargetId({
        cdpUrl: "http://127.0.0.1:19996",
      });
      await Promise.resolve();
      await Promise.resolve();

      await closePlaywrightBrowserConnection({ cdpUrl: "http://127.0.0.1:19996" });
      deferredNeutralization.resolve();

      await expect(pending).rejects.toThrow("CDP browser connection closed during setup");
      expect(firstHarness.browserClose).toHaveBeenCalledTimes(1);

      const secondHarness = createExtensionFallbackBrowserHarness({
        urls: ["https://beta.example"],
      });
      const [secondPage] = secondHarness.pages;

      await expect(
        getPageForTargetId({
          cdpUrl: "http://127.0.0.1:19996",
        }),
      ).resolves.toBe(secondPage);
      expect(connectOverCdpSpy).toHaveBeenCalledTimes(2);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
