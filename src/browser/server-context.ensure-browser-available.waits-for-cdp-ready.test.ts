import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunningChrome } from "./chrome.js";
import type { BrowserServerState } from "./server-context.js";

const mocks = vi.hoisted(() => ({
  launchOpenClawChrome: vi.fn(),
  stopOpenClawChrome: vi.fn(async () => {}),
  isChromeReachable: vi.fn(async () => false),
  isChromeCdpReady: vi.fn(async () => true),
}));

let createBrowserRouteContext: typeof import("./server-context.js").createBrowserRouteContext;

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
      cdpPortRangeStart: 18800,
      cdpPortRangeEnd: 18810,
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

function mockLaunchedChrome(pid: number) {
  const proc = new EventEmitter() as unknown as ChildProcessWithoutNullStreams;
  mocks.launchOpenClawChrome.mockResolvedValue({
    pid,
    exe: { kind: "chromium", path: "/usr/bin/chromium" },
    userDataDir: "/tmp/openclaw-test",
    cdpPort: 18800,
    startedAt: Date.now(),
    proc,
  });
}

function setupEnsureBrowserAvailableHarness() {
  vi.useFakeTimers();
  mocks.launchOpenClawChrome.mockReset();
  mocks.stopOpenClawChrome.mockReset().mockResolvedValue(undefined);
  mocks.isChromeReachable.mockReset().mockResolvedValue(false);
  mocks.isChromeCdpReady.mockReset().mockResolvedValue(true);

  const state = makeBrowserState();
  const ctx = createBrowserRouteContext({ getState: () => state });
  const profile = ctx.forProfile("openclaw");

  return {
    launchOpenClawChrome: mocks.launchOpenClawChrome,
    stopOpenClawChrome: mocks.stopOpenClawChrome,
    isChromeCdpReady: mocks.isChromeCdpReady,
    profile,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

beforeEach(async () => {
  vi.resetModules();
  vi.doMock("./chrome.js", () => ({
    isChromeCdpReady: mocks.isChromeCdpReady,
    isChromeReachable: mocks.isChromeReachable,
    launchOpenClawChrome: mocks.launchOpenClawChrome,
    resolveOpenClawUserDataDir: vi.fn(() => "/tmp/openclaw"),
    stopOpenClawChrome: mocks.stopOpenClawChrome,
  }));
  ({ createBrowserRouteContext } = await import("./server-context.js"));
});

describe("browser server-context ensureBrowserAvailable", () => {
  it("waits for CDP readiness after launching to avoid follow-up PortInUseError races (#21149)", async () => {
    const { launchOpenClawChrome, stopOpenClawChrome, isChromeCdpReady, profile } =
      setupEnsureBrowserAvailableHarness();
    isChromeCdpReady.mockResolvedValueOnce(false).mockResolvedValue(true);
    mockLaunchedChrome(123);

    const promise = profile.ensureBrowserAvailable();
    await vi.advanceTimersByTimeAsync(250);
    await expect(promise).resolves.toBeUndefined();

    expect(launchOpenClawChrome).toHaveBeenCalledTimes(1);
    expect(isChromeCdpReady).toHaveBeenCalled();
    expect(stopOpenClawChrome).not.toHaveBeenCalled();
  });

  it("stops launched chrome when CDP readiness never arrives", async () => {
    const { launchOpenClawChrome, stopOpenClawChrome, isChromeCdpReady, profile } =
      setupEnsureBrowserAvailableHarness();
    isChromeCdpReady.mockResolvedValue(false);
    mockLaunchedChrome(321);

    const promise = profile.ensureBrowserAvailable();
    const rejected = expect(promise).rejects.toThrow("not reachable after start");
    await vi.advanceTimersByTimeAsync(8100);
    await rejected;

    expect(launchOpenClawChrome).toHaveBeenCalledTimes(1);
    expect(stopOpenClawChrome).toHaveBeenCalledTimes(1);
  });
});
