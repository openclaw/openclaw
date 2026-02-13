import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserServerState } from "./server-context.js";

const chromeMocks = vi.hoisted(() => ({
  isChromeCdpReady: vi.fn(async () => true),
  isChromeReachable: vi.fn(async () => true),
  launchOpenClawChrome: vi.fn(async () => {
    throw new Error("unexpected launch");
  }),
  resolveOpenClawUserDataDir: vi.fn(() => "/tmp/openclaw"),
  stopOpenClawChrome: vi.fn(async () => {}),
}));

const relayMocks = vi.hoisted(() => ({
  ensureChromeExtensionRelayServer: vi.fn(async () => {}),
  stopChromeExtensionRelayServer: vi.fn(async () => false),
}));

vi.mock("./chrome.js", () => chromeMocks);
vi.mock("./extension-relay.js", () => relayMocks);

describe("browser server-context browser-use driver", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    chromeMocks.isChromeReachable.mockResolvedValue(true);
    chromeMocks.isChromeCdpReady.mockResolvedValue(true);
  });

  function makeState(): BrowserServerState {
    return {
      // oxlint-disable-next-line typescript/no-explicit-any
      server: null as any,
      port: 0,
      resolved: {
        enabled: true,
        evaluateEnabled: true,
        controlPort: 18791,
        cdpProtocol: "http",
        cdpHost: "127.0.0.1",
        cdpIsLoopback: true,
        remoteCdpTimeoutMs: 1500,
        remoteCdpHandshakeTimeoutMs: 3000,
        color: "#FF4500",
        headless: false,
        noSandbox: false,
        attachOnly: false,
        defaultProfile: "browser-use",
        profiles: {
          "browser-use": {
            driver: "browser-use",
            cdpUrl: "http://127.0.0.1:9222",
            color: "#4A90E2",
          },
        },
      },
      profiles: new Map(),
    };
  }

  it("does not start managed chrome or extension relay when browser-use CDP is reachable", async () => {
    const { createBrowserRouteContext } = await import("./server-context.js");
    const state = makeState();
    const ctx = createBrowserRouteContext({ getState: () => state });

    await ctx.forProfile("browser-use").ensureBrowserAvailable();

    expect(chromeMocks.launchOpenClawChrome).not.toHaveBeenCalled();
    expect(relayMocks.ensureChromeExtensionRelayServer).not.toHaveBeenCalled();
  });

  it("returns a browser-use specific error when CDP is unreachable", async () => {
    chromeMocks.isChromeReachable.mockResolvedValue(false);

    const { createBrowserRouteContext } = await import("./server-context.js");
    const state = makeState();
    const ctx = createBrowserRouteContext({ getState: () => state });

    await expect(ctx.forProfile("browser-use").ensureBrowserAvailable()).rejects.toThrow(
      /browser-use CDP/i,
    );

    expect(chromeMocks.launchOpenClawChrome).not.toHaveBeenCalled();
    expect(relayMocks.ensureChromeExtensionRelayServer).not.toHaveBeenCalled();
  });
});
