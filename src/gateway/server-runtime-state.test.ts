/**
 * Gateway runtime state construction tests.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  armStartupWatchdog,
  getLastStartupWatchdogLineForTest,
  isStartupWatchdogArmedForTest,
  resetStartupWatchdogForTest,
} from "../logging/gateway-startup-watchdog.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import {
  getActivePluginChannelRegistry,
  pinActivePluginHttpRouteRegistry,
  pinActivePluginChannelRegistry,
  releasePinnedPluginChannelRegistry,
  releasePinnedPluginHttpRouteRegistry,
  resetPluginRuntimeStateForTest,
  resolveActivePluginHttpRouteRegistry,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { createGatewayRuntimeStateForTest } from "./test-helpers.server-runtime-state.js";

// Mocked seam for the multi-bind regression test below: we drive
// `listenGatewayHttpServer` directly so the test can simulate "first host
// binds successfully, second host hangs forever" without opening real
// sockets.
const listenGatewayHttpServerMock = vi.hoisted(() =>
  vi.fn(
    async (_params: { httpServer: unknown; bindHost: string; port: number }): Promise<void> => {},
  ),
);
vi.mock("./server/http-listen.js", () => ({
  listenGatewayHttpServer: listenGatewayHttpServerMock,
}));

// Mocked seam so the multi-bind test always sees 2 hosts regardless of the
// loopback `::1` probe the production resolver does at construction time.
const resolveGatewayListenHostsMock = vi.hoisted(() =>
  vi.fn(async (_host: string): Promise<string[]> => ["127.0.0.1"]),
);
vi.mock("./net.js", async () => {
  const actual = await vi.importActual<typeof import("./net.js")>("./net.js");
  return {
    ...actual,
    resolveGatewayListenHosts: resolveGatewayListenHostsMock,
  };
});

function createRegistryWithRoute(path: string) {
  const registry = createEmptyPluginRegistry();
  registry.httpRoutes.push({
    path,
    auth: "plugin",
    match: "exact",
    handler: () => true,
    pluginId: "demo",
    source: "test",
  });
  return registry;
}

describe("createGatewayRuntimeState", () => {
  afterEach(() => {
    releasePinnedPluginHttpRouteRegistry();
    releasePinnedPluginChannelRegistry();
    resetPluginRuntimeStateForTest();
    listenGatewayHttpServerMock.mockReset();
    listenGatewayHttpServerMock.mockImplementation(async () => {});
    resolveGatewayListenHostsMock.mockReset();
    resolveGatewayListenHostsMock.mockImplementation(async (host: string) => [host]);
    resetStartupWatchdogForTest();
  });

  it("releases post-bootstrap repinned plugin registries on cleanup", async () => {
    const startupRegistry = createRegistryWithRoute("/startup");
    const loadedRegistry = createRegistryWithRoute("/loaded");
    const fallbackRegistry = createRegistryWithRoute("/fallback");

    setActivePluginRegistry(startupRegistry);
    const runtimeState = await createGatewayRuntimeStateForTest(startupRegistry);

    pinActivePluginHttpRouteRegistry(loadedRegistry);
    pinActivePluginChannelRegistry(loadedRegistry);
    expect(resolveActivePluginHttpRouteRegistry(fallbackRegistry)).toBe(loadedRegistry);
    expect(getActivePluginChannelRegistry()).toBe(loadedRegistry);

    runtimeState.releasePluginRouteRegistry();

    expect(resolveActivePluginHttpRouteRegistry(fallbackRegistry)).toBe(startupRegistry);
    expect(getActivePluginChannelRegistry()).toBe(startupRegistry);
  });

  // Multi-bind silent-hang regression (clawsweeper finding on PR #91080):
  //
  // `resolveGatewayListenHosts("127.0.0.1")` returns `["127.0.0.1", "::1"]`
  // on dual-stack loopback. `startListening` then loops the hosts and
  // awaits `listenGatewayHttpServer` per host. The earlier version of the
  // watchdog wiring cancelled the watchdog inside the per-host
  // `onListening` callback in `http-listen.ts`, so the first bind disarmed
  // the watchdog even when subsequent binds hung — exactly the
  // silent-hang class the watchdog is built to catch.
  //
  // This test pins the contract: when bind 1 resolves and bind 2 hangs,
  // the watchdog stays armed and fires once the threshold elapses. The
  // production cancel point now lives in `server.impl.ts` after
  // `startupTrace.mark("http.bound")`, which only runs after `startListening`
  // returns — i.e. after every bind host has bound. If a future refactor
  // moves the cancel back into the per-bind path, this test breaks.
  it("keeps the startup watchdog armed when the second bind host hangs", async () => {
    resolveGatewayListenHostsMock.mockImplementation(async (host: string) => {
      if (host === "127.0.0.1") {
        return ["127.0.0.1", "::1"];
      }
      return [host];
    });

    // First bind resolves immediately; second bind never resolves.
    let secondBindReached = false;
    listenGatewayHttpServerMock.mockImplementation(async (params) => {
      if (params.bindHost === "127.0.0.1") {
        return;
      }
      secondBindReached = true;
      // Park forever — caller will surface the hang via the watchdog, not
      // via any signal the mock emits. The resolver is intentionally
      // never invoked; the unsettled promise is released when
      // `vi.useRealTimers()` runs in the finally block.
      await new Promise<void>(() => {});
    });

    vi.useFakeTimers();
    try {
      const runtimeState = await createGatewayRuntimeStateForTest();

      // Arm the watchdog with a short threshold so the test stays fast.
      const armed = armStartupWatchdog({ thresholdMs: 50 });
      expect(armed).toBe(true);
      expect(isStartupWatchdogArmedForTest()).toBe(true);

      // Kick off startListening but do not await — we expect it to hang
      // on the second bind. The `void` discard keeps the pending promise
      // off the test's await chain.
      const startPromise = runtimeState.startListening();
      void startPromise;

      // Let the first-bind microtask resolve before we advance fake time.
      await Promise.resolve();
      await Promise.resolve();

      // Advance past the watchdog threshold. With the cancel moved out of
      // `http-listen.ts`, the first bind no longer disarms the watchdog,
      // so the timer fires.
      vi.advanceTimersByTime(60);

      const line = getLastStartupWatchdogLineForTest();
      expect(line).toBeDefined();
      expect(line).toContain("[startup-watchdog] stuck step=");
      expect(line).toContain("threshold=50ms");
      expect(isStartupWatchdogArmedForTest()).toBe(false);

      // Sanity: only the first bind completed; the second was reached but
      // never resolved.
      expect(runtimeState.httpBindHosts).toEqual(["127.0.0.1"]);
      expect(secondBindReached).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
