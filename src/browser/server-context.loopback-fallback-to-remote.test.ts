import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserServerState } from "./server-context.js";
import "./server-context.chrome-test-harness.js";
import { createBrowserRouteContext } from "./server-context.js";

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Build a BrowserServerState with both a loopback "openclaw" profile and a remote profile.
 * This simulates a containerized gateway that has a remote browser pod but no local Chrome.
 */
function makeStateWithRemoteDefault(): BrowserServerState {
  return {
    server: null,
    port: 0,
    resolved: {
      enabled: true,
      controlPort: 18791,
      cdpProtocol: "http",
      cdpHost: "127.0.0.1",
      cdpIsLoopback: true,
      remoteCdpTimeoutMs: 1500,
      remoteCdpHandshakeTimeoutMs: 3000,
      evaluateEnabled: false,
      extraArgs: [],
      color: "#FF4500",
      headless: false,
      noSandbox: false,
      attachOnly: false,
      ssrfPolicy: { allowPrivateNetwork: true },
      defaultProfile: "remote",
      profiles: {
        remote: {
          cdpUrl: "http://openclaw-browser.openclaw.svc.cluster.local:9222",
          cdpPort: 9222,
          color: "#0066CC",
        },
        openclaw: { cdpPort: 18800, color: "#FF4500" },
      },
    },
    profiles: new Map(),
  };
}

describe("ensureBrowserAvailable loopback-to-remote fallback", () => {
  it("suggests the remote default profile when local Chrome is not installed", async () => {
    const state = makeStateWithRemoteDefault();

    // Mock: loopback CDP port is not reachable (nothing running locally)
    const { isChromeReachable, resolveBrowserExecutable } = await import("./chrome.js");
    vi.mocked(isChromeReachable).mockResolvedValue(false);
    // No Chrome executable installed
    vi.mocked(resolveBrowserExecutable).mockReturnValue(null);

    const ctx = createBrowserRouteContext({
      getState: () => state,
      refreshConfigFromDisk: false,
    });

    // Request the "openclaw" loopback profile explicitly (this is what the LLM does)
    const profileCtx = ctx.forProfile("openclaw");

    await expect(profileCtx.ensureBrowserAvailable()).rejects.toThrow(
      /Use the default profile "remote" instead/,
    );
  });

  it("throws original error when no remote default profile exists", async () => {
    const state = makeStateWithRemoteDefault();
    // Make the default profile also loopback
    state.resolved.defaultProfile = "openclaw";

    const { isChromeReachable, resolveBrowserExecutable } = await import("./chrome.js");
    vi.mocked(isChromeReachable).mockResolvedValue(false);
    vi.mocked(resolveBrowserExecutable).mockReturnValue(null);

    const ctx = createBrowserRouteContext({
      getState: () => state,
      refreshConfigFromDisk: false,
    });

    const profileCtx = ctx.forProfile("openclaw");

    // Should fall through to launchOpenClawChrome which throws "unexpected launch" (from harness mock)
    await expect(profileCtx.ensureBrowserAvailable()).rejects.toThrow("unexpected launch");
  });
});
