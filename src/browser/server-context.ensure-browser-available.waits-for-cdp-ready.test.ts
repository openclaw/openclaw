import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as chromeModule from "./chrome.js";
import "./server-context.chrome-test-harness.js";
import type { BrowserServerState } from "./server-context.js";
import { createBrowserRouteContext } from "./server-context.js";

function makeBrowserState(): BrowserServerState {
  return {
    // oxlint-disable-next-line typescript/no-explicit-any
    server: null as any,
    port: 0,
    resolved: {
      enabled: true,
      controlPort: 18791,
      cdpProtocol: "http",
      cdpHost: "127.0.0.1",
      cdpIsLoopback: true,
      evaluateEnabled: false,
      remoteCdpTimeoutMs: 1500,
      remoteCdpHandshakeTimeoutMs: 3000,
      extraArgs: [],
      color: "#FF4500",
      headless: true,
      noSandbox: false,
      attachOnly: false,
      ssrfPolicy: { allowPrivateNetwork: true },
      defaultProfile: "openclaw",
      profiles: {
        openclaw: { cdpPort: 18800, color: "#FF4500" },
      },
    },
    profiles: new Map(),
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("browser server-context ensureBrowserAvailable", () => {
  it("waits for CDP readiness after launching to avoid follow-up PortInUseError races (#21149)", async () => {
    vi.useFakeTimers();

    const launchOpenClawChrome = vi.mocked(chromeModule.launchOpenClawChrome);
    const stopOpenClawChrome = vi.mocked(chromeModule.stopOpenClawChrome);
    const isChromeReachable = vi.mocked(chromeModule.isChromeReachable);
    const isChromeCdpReady = vi.mocked(chromeModule.isChromeCdpReady);

    isChromeReachable.mockResolvedValue(false);
    isChromeCdpReady.mockResolvedValueOnce(false).mockResolvedValue(true);

    const proc = new EventEmitter() as unknown as ChildProcessWithoutNullStreams;
    launchOpenClawChrome.mockResolvedValue({
      pid: 123,
      exe: { kind: "chromium", path: "/usr/bin/chromium" },
      userDataDir: "/tmp/openclaw-test",
      cdpPort: 18800,
      startedAt: Date.now(),
      proc,
    });

    const state = makeBrowserState();
    const ctx = createBrowserRouteContext({ getState: () => state });
    const profile = ctx.forProfile("openclaw");

    const promise = profile.ensureBrowserAvailable();
    await vi.advanceTimersByTimeAsync(100);
    await expect(promise).resolves.toBeUndefined();

    expect(launchOpenClawChrome).toHaveBeenCalledTimes(1);
    expect(isChromeCdpReady).toHaveBeenCalled();
    expect(stopOpenClawChrome).not.toHaveBeenCalled();
  });
});
