/* @vitest-environment jsdom */

import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { MockWebSocket, wsInstances } from "../api/gateway-socket.test-support.ts";
import { GatewayBrowserClient } from "../api/gateway.ts";
import { startGatewayPageActivation } from "./gateway-page-activation.ts";
import type { ApplicationGatewayPhase } from "./gateway.ts";
import { refreshControlUiServiceWorker } from "./sw-refresh.runtime.ts";

vi.mock("./sw-refresh.runtime.ts", () => ({
  refreshControlUiServiceWorker: vi.fn(async () => false),
}));

afterEach(() => {
  vi.mocked(refreshControlUiServiceWorker).mockClear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function setup(phase: ApplicationGatewayPhase, stale = true, hidden = false) {
  const connect = vi.fn();
  const visibility = vi.spyOn(document, "visibilityState", "get");
  visibility.mockReturnValue(hidden ? "hidden" : "visible");
  const snapshot = {
    phase,
    lastErrorCode: null,
    client: {
      needsWakeReconnect: stale,
      needsReachabilityReconnect: false,
      gatewayUrl: "ws://localhost",
    },
  };
  const dispose = startGatewayPageActivation(
    { snapshot, connect, subscribe: () => () => {} },
    document,
    window,
  );
  onTestFinished(dispose);
  const foreground = () => {
    visibility.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
  };
  return { connect, visibility, dispose, foreground };
}
const online = () => window.dispatchEvent(new Event("online"));
const pageshow = (persisted: boolean) =>
  window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted }));

it.each(["stopped", "offline", "reload-required"] as const)(
  "preserves %s across page restoration, online, and visibility signals",
  async (phase: ApplicationGatewayPhase) => {
    const { connect, visibility, foreground } = setup(phase);
    for (const activate of [
      () => pageshow(true),
      online,
      () => {
        visibility.mockReturnValue("hidden");
        document.dispatchEvent(new Event("visibilitychange"));
        foreground();
      },
    ]) {
      const refreshed = Promise.withResolvers<void>();
      vi.mocked(refreshControlUiServiceWorker).mockImplementationOnce(async () => {
        refreshed.resolve();
        return false;
      });
      activate();
      await refreshed.promise;
    }
    expect(connect).not.toHaveBeenCalled();
    expect(refreshControlUiServiceWorker).toHaveBeenCalledTimes(3);
  },
);

it.each([
  ["reconnecting", true, 1],
  ["connected", false, 0],
] as const)("coalesces online/foreground signals for a %s client", async (phase, stale, calls) => {
  const { connect, foreground } = setup(phase, stale, stale);
  if (stale) {
    foreground();
  }
  online();
  await Promise.resolve();
  expect(connect).toHaveBeenCalledTimes(calls);
  await vi.waitFor(() => expect(refreshControlUiServiceWorker).toHaveBeenCalledOnce());
});

it("ignores initial pageshow and removes every listener on dispose", async () => {
  const { connect, dispose } = setup("connecting");
  pageshow(false);
  await Promise.resolve();
  expect(connect).not.toHaveBeenCalled();

  dispose();
  pageshow(true);
  online();
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
  expect(connect).not.toHaveBeenCalled();
  expect(refreshControlUiServiceWorker).not.toHaveBeenCalled();
});

function setupRecovery() {
  vi.useFakeTimers({
    toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  });
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vi.stubGlobal("WebSocket", MockWebSocket);
  wsInstances.length = 0;
  const fetchProbe = vi.fn(async (_url: URL, _options: RequestInit) =>
    Response.json({ ok: true, status: "live" }),
  );
  vi.stubGlobal("fetch", fetchProbe);
  const listeners = new Set<() => void>();
  const makeClient = () => new GatewayBrowserClient({ url: `ws://${window.location.host}` });
  const snapshot: {
    client: GatewayBrowserClient;
    phase: ApplicationGatewayPhase;
    lastErrorCode: string | null;
    restartPending?: boolean;
    suspensionPhase?: "draining" | "accepting";
  } = { client: makeClient(), phase: "reconnecting", lastErrorCode: null };
  const notify = () => listeners.forEach((listener) => listener());
  const connect = vi.fn(() => {
    snapshot.client.stop();
    snapshot.client = makeClient();
    snapshot.client.start();
    notify();
  });
  snapshot.client.start();
  const dispose = startGatewayPageActivation(
    {
      snapshot,
      connect,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    document,
    window,
  );
  onTestFinished(() => {
    dispose();
    snapshot.client.stop();
  });
  return { snapshot, connect, fetchProbe, visibility, notify, dispose };
}

it("replaces a blackholed opening on fresh reachability evidence without an online event", async () => {
  const { connect, fetchProbe, snapshot, notify } = setupRecovery();
  fetchProbe.mockRejectedValue(new TypeError("offline"));
  await vi.advanceTimersByTimeAsync(10_000);
  expect(connect).not.toHaveBeenCalled();
  fetchProbe.mockResolvedValue(Response.json({ ok: true, status: "live" }));
  await vi.advanceTimersByTimeAsync(2_500);
  expect(connect).toHaveBeenCalledOnce();
  expect(wsInstances).toHaveLength(2);
  expect(wsInstances[0]?.lastClose).not.toBeNull();
  snapshot.phase = "connected";
  notify();
  await vi.advanceTimersByTimeAsync(20_000);
  expect(connect).toHaveBeenCalledOnce();
});

it("cuts short transport backoff after a successful fresh probe", async () => {
  const { connect, fetchProbe } = setupRecovery();
  fetchProbe.mockRejectedValue(new TypeError("offline"));
  // Grow the real protocol backoff past the 2.5-second reachability interval.
  for (const wait of [800, 1_360, 2_312]) {
    wsInstances.at(-1)!.emitClose(1006, "network lost");
    await vi.advanceTimersByTimeAsync(wait);
  }
  wsInstances.at(-1)!.emitClose(1006, "network lost");
  fetchProbe.mockResolvedValue(Response.json({ ok: true, status: "live" }));
  await vi.advanceTimersByTimeAsync(2_500);
  expect(connect).toHaveBeenCalledOnce();
});

it.each([
  "young opening",
  "opened socket",
  "hidden",
  "restart",
  "suspension",
  "starting",
  "busy",
  "stopped",
])("does not replace a %s client on periodic reachability evidence", async (kind) => {
  const { connect, fetchProbe, visibility, snapshot, notify } = setupRecovery();
  if (kind === "opened socket") {
    wsInstances[0]!.emitOpen();
  }
  if (kind === "hidden") {
    visibility.mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
  }
  if (kind === "restart") {
    snapshot.restartPending = true;
  }
  if (kind === "suspension") {
    snapshot.suspensionPhase = "draining";
  }
  if (kind === "starting") {
    snapshot.phase = "starting";
  }
  if (kind === "stopped") {
    snapshot.phase = "stopped";
  }
  if (kind === "busy") {
    snapshot.lastErrorCode = "GATEWAY_BUSY";
  }
  notify();
  await vi.advanceTimersByTimeAsync(kind === "young opening" ? 7_999 : 15_000);
  expect(connect).not.toHaveBeenCalled();
  expect(fetchProbe).not.toHaveBeenCalled();
});

it.each(["hidden", "connected", "opened", "replaced", "restart", "dispose"])(
  "ignores a probe that succeeds after the page is %s",
  async (kind) => {
    const { connect, fetchProbe, snapshot, visibility, notify, dispose } = setupRecovery();
    const pending = Promise.withResolvers<Response>();
    fetchProbe.mockReturnValue(pending.promise);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchProbe).toHaveBeenCalledOnce();
    if (kind === "hidden") {
      visibility.mockReturnValue("hidden");
      document.dispatchEvent(new Event("visibilitychange"));
    }
    if (kind === "connected") {
      snapshot.phase = "connected";
    }
    if (kind === "opened") {
      wsInstances[0]!.emitOpen();
    }
    if (kind === "restart") {
      snapshot.restartPending = true;
    }
    if (kind === "replaced") {
      snapshot.client.stop();
      snapshot.client = new GatewayBrowserClient({ url: `ws://${window.location.host}` });
      snapshot.client.start();
    }
    if (kind === "dispose") {
      dispose();
    }
    notify();
    pending.resolve(Response.json({ ok: true, status: "live" }));
    await vi.advanceTimersByTimeAsync(0);
    expect(connect).not.toHaveBeenCalled();
  },
);

it("does not overlap slow probes or replace a socket on a response past the deadline", async () => {
  const { connect, fetchProbe } = setupRecovery();
  const pending = Promise.withResolvers<Response>();
  fetchProbe.mockReturnValue(pending.promise);
  await vi.advanceTimersByTimeAsync(15_000);
  expect(fetchProbe).toHaveBeenCalledOnce();
  expect(fetchProbe.mock.calls[0]?.[1].signal?.aborted).toBe(true);
  pending.resolve(Response.json({ ok: true, status: "live" }));
  await vi.advanceTimersByTimeAsync(0);
  expect(connect).not.toHaveBeenCalled();
});

it("includes failed fetch time in the probe interval instead of delaying the next recovery check", async () => {
  const { fetchProbe, connect } = setupRecovery();
  fetchProbe.mockImplementation(
    (_url, options) =>
      new Promise((_resolve, reject) => {
        options.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      }),
  );
  await vi.advanceTimersByTimeAsync(12_500);
  expect(fetchProbe).toHaveBeenCalledTimes(2);
  expect(connect).not.toHaveBeenCalled();
});
