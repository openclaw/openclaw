import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient, GatewayHelloOk } from "../api/gateway.ts";
import type { ApplicationGateway, ApplicationGatewaySnapshot } from "../app/gateway.ts";
import { sessionViewerPresenceForGateway } from "./session-viewer-presence.ts";

const SESSION_VIEWERS_SET_METHOD = "sessions.viewers.set";

function createHello(mainSessionKey = "agent:main:main"): GatewayHelloOk {
  return {
    type: "hello-ok",
    protocol: 1,
    auth: { role: "operator", scopes: [] },
    features: { methods: [SESSION_VIEWERS_SET_METHOD] },
    snapshot: { sessionDefaults: { mainSessionKey } },
  } as GatewayHelloOk;
}

function createGatewayHarness() {
  const request = vi.fn<GatewayBrowserClient["request"]>().mockResolvedValue({ sessionKeys: [] });
  const client = { request } as unknown as GatewayBrowserClient;
  let snapshot: ApplicationGatewaySnapshot = {
    client,
    phase: "connected",
    offlineStable: false,
    hello: createHello(),
    canvasPluginSurfaceUrl: null,
    assistantAgentId: "main",
    sessionKey: "agent:main:main",
    lastError: null,
    lastErrorCode: null,
  };
  const listeners = new Set<(value: ApplicationGatewaySnapshot) => void>();
  const unsubscribe = vi.fn();
  const gateway = {
    get snapshot() {
      return snapshot;
    },
    connection: { gatewayUrl: "ws://example.test", token: "", bootstrapToken: "", password: "" },
    connectionRevision: 0,
    eventLog: [],
    eventLogRevision: 0,
    subscribe: vi.fn((listener: (value: ApplicationGatewaySnapshot) => void) => {
      listeners.add(listener);
      return () => {
        unsubscribe();
        listeners.delete(listener);
      };
    }),
    subscribeEvents: () => () => {},
    subscribeEventLog: () => () => {},
    connect: vi.fn(),
    setSessionKey: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  } as ApplicationGateway;
  return {
    client,
    gateway,
    request,
    unsubscribe,
    setSnapshot(next: ApplicationGatewaySnapshot) {
      snapshot = next;
      for (const listener of listeners) {
        listener(snapshot);
      }
    },
  };
}

async function flushSync() {
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
}

beforeEach(() => {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
});

describe("session viewer presence store", () => {
  it("declares the bounded union and replaces it as panes switch or close", async () => {
    const harness = createGatewayHarness();
    const store = sessionViewerPresenceForGateway(harness.gateway);
    const firstPane = {};
    const secondPane = {};

    store.watch(firstPane, ["main"]);
    store.watch(secondPane, ["agent:main:other"]);
    await flushSync();
    expect(harness.request).toHaveBeenLastCalledWith(SESSION_VIEWERS_SET_METHOD, {
      sessionKeys: ["agent:main:main", "agent:main:other"],
    });

    store.watch(firstPane, ["agent:main:replacement"]);
    await flushSync();
    expect(harness.request).toHaveBeenLastCalledWith(SESSION_VIEWERS_SET_METHOD, {
      sessionKeys: ["agent:main:other", "agent:main:replacement"],
    });

    store.unwatch(secondPane);
    await flushSync();
    expect(harness.request).toHaveBeenLastCalledWith(SESSION_VIEWERS_SET_METHOD, {
      sessionKeys: ["agent:main:replacement"],
    });

    store.unwatch(firstPane);
    await flushSync();
    expect(harness.request).toHaveBeenLastCalledWith(SESSION_VIEWERS_SET_METHOD, {
      sessionKeys: [],
    });
    expect(harness.unsubscribe).toHaveBeenCalledOnce();
  });

  it("threads the selected owner for a bare global viewer identity", async () => {
    const harness = createGatewayHarness();
    harness.setSnapshot({
      ...harness.gateway.snapshot,
      assistantAgentId: "work",
      hello: createHello("global"),
    });
    const store = sessionViewerPresenceForGateway(harness.gateway);
    const owner = {};
    store.watch(owner, ["global"]);
    await flushSync();

    expect(harness.request).toHaveBeenLastCalledWith(SESSION_VIEWERS_SET_METHOD, {
      agentId: "work",
      sessionKeys: ["global"],
    });
    store.unwatch(owner);
    await flushSync();
  });

  it("declares empty while hidden and restores the set when visible", async () => {
    const harness = createGatewayHarness();
    const store = sessionViewerPresenceForGateway(harness.gateway);
    const owner = {};
    store.watch(owner, ["agent:main:visible"]);
    await flushSync();

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    await flushSync();
    expect(harness.request).toHaveBeenLastCalledWith(SESSION_VIEWERS_SET_METHOD, {
      sessionKeys: [],
    });

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
    await flushSync();
    expect(harness.request).toHaveBeenLastCalledWith(SESSION_VIEWERS_SET_METHOD, {
      sessionKeys: ["agent:main:visible"],
    });
    store.unwatch(owner);
    await flushSync();
  });

  it("redeclares aliases against the new client hello", async () => {
    const harness = createGatewayHarness();
    const store = sessionViewerPresenceForGateway(harness.gateway);
    const owner = {};
    store.watch(owner, ["main"]);
    await flushSync();
    expect(harness.request).toHaveBeenCalledTimes(1);
    expect(harness.request).toHaveBeenLastCalledWith(SESSION_VIEWERS_SET_METHOD, {
      sessionKeys: ["agent:main:main"],
    });

    harness.setSnapshot({ ...harness.gateway.snapshot, phase: "reconnecting", hello: null });
    const nextRequest = vi
      .fn<GatewayBrowserClient["request"]>()
      .mockResolvedValue({ sessionKeys: ["agent:main:visible"] });
    const nextClient = { request: nextRequest } as unknown as GatewayBrowserClient;
    harness.setSnapshot({
      ...harness.gateway.snapshot,
      client: nextClient,
      phase: "connected",
      hello: createHello("agent:work:home"),
    });
    await flushSync();

    expect(nextRequest).toHaveBeenCalledWith(SESSION_VIEWERS_SET_METHOD, {
      sessionKeys: ["agent:work:home"],
    });
    store.unwatch(owner);
    await flushSync();
  });

  it("retries a transient declaration failure without stranding module listeners", async () => {
    vi.useFakeTimers();
    const harness = createGatewayHarness();
    harness.request.mockRejectedValueOnce(new Error("temporarily unavailable"));
    const store = sessionViewerPresenceForGateway(harness.gateway);
    const owner = {};
    store.watch(owner, ["agent:main:visible"]);
    await flushSync();
    expect(harness.request).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(30_000);
    await flushSync();
    expect(harness.request.mock.calls.length).toBeGreaterThanOrEqual(2);

    store.unwatch(owner);
    await flushSync();
    expect(vi.getTimerCount()).toBe(0);
    expect(harness.unsubscribe).toHaveBeenCalledOnce();
  });

  it("retries the final empty declaration before detaching listeners", async () => {
    vi.useFakeTimers();
    const harness = createGatewayHarness();
    const store = sessionViewerPresenceForGateway(harness.gateway);
    const owner = {};
    store.watch(owner, ["agent:main:visible"]);
    await flushSync();

    let rejectClear!: (error: Error) => void;
    harness.request.mockReturnValueOnce(
      new Promise<never>((_resolve, reject) => {
        rejectClear = reject;
      }),
    );
    store.unwatch(owner);
    await flushSync();
    expect(harness.request).toHaveBeenCalledTimes(2);
    expect(harness.unsubscribe).not.toHaveBeenCalled();

    // Snapshot/visibility churn while the clear is in flight must not treat the
    // sent signature as acknowledged and detach before a rejection can retry.
    document.dispatchEvent(new Event("visibilitychange"));
    await flushSync();
    expect(harness.unsubscribe).not.toHaveBeenCalled();
    rejectClear(new Error("clear temporarily unavailable"));
    await flushSync();

    await vi.advanceTimersByTimeAsync(30_000);
    await flushSync();
    expect(harness.request).toHaveBeenCalledTimes(3);
    expect(harness.request).toHaveBeenLastCalledWith(SESSION_VIEWERS_SET_METHOD, {
      sessionKeys: [],
    });
    expect(harness.unsubscribe).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not treat an older empty acknowledgement as the current final clear", async () => {
    vi.useFakeTimers();
    const harness = createGatewayHarness();
    const store = sessionViewerPresenceForGateway(harness.gateway);
    const owner = {};
    store.watch(owner, ["agent:main:visible"]);
    await flushSync();

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    await flushSync();

    let resolveVisible!: (value: { sessionKeys: string[] }) => void;
    let rejectFinalClear!: (error: Error) => void;
    harness.request
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveVisible = resolve;
        }),
      )
      .mockReturnValueOnce(
        new Promise<never>((_resolve, reject) => {
          rejectFinalClear = reject;
        }),
      );
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
    await flushSync();
    store.unwatch(owner);
    await flushSync();
    // The clear waits for the active request; never race declarations on one connection.
    expect(harness.request).toHaveBeenCalledTimes(3);

    document.dispatchEvent(new Event("visibilitychange"));
    await flushSync();
    expect(harness.unsubscribe).not.toHaveBeenCalled();

    resolveVisible({ sessionKeys: ["agent:main:visible"] });
    await flushSync();
    expect(harness.request).toHaveBeenCalledTimes(4);
    expect(harness.unsubscribe).not.toHaveBeenCalled();
    rejectFinalClear(new Error("final clear temporarily unavailable"));
    await flushSync();
    await vi.advanceTimersByTimeAsync(30_000);
    await flushSync();

    expect(harness.request).toHaveBeenCalledTimes(5);
    expect(harness.request).toHaveBeenLastCalledWith(SESSION_VIEWERS_SET_METHOD, {
      sessionKeys: [],
    });
    expect(harness.unsubscribe).toHaveBeenCalledOnce();
  });
  it("renews only focused visible watching, expires on human idle, and releases timers", async () => {
    vi.useFakeTimers();
    const harness = createGatewayHarness();
    const store = sessionViewerPresenceForGateway(harness.gateway);
    const owner = {};
    store.watch(owner, ["main"]);
    await flushSync();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(harness.request).toHaveBeenCalledTimes(2);
    window.dispatchEvent(new Event("blur"));
    await flushSync();
    expect(harness.request).toHaveBeenLastCalledWith(SESSION_VIEWERS_SET_METHOD, {
      sessionKeys: [],
    });
    const blurredCount = harness.request.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(harness.request).toHaveBeenCalledTimes(blurredCount);
    window.dispatchEvent(new Event("focus"));
    await flushSync();
    expect(harness.request).toHaveBeenLastCalledWith(SESSION_VIEWERS_SET_METHOD, {
      sessionKeys: ["agent:main:main"],
    });
    await vi.advanceTimersByTimeAsync(119_999);
    expect(harness.request).toHaveBeenLastCalledWith(SESSION_VIEWERS_SET_METHOD, {
      sessionKeys: ["agent:main:main"],
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(harness.request).toHaveBeenLastCalledWith(SESSION_VIEWERS_SET_METHOD, {
      sessionKeys: [],
    });
    expect(vi.getTimerCount()).toBe(0);
    document.dispatchEvent(new Event("pointerdown"));
    await flushSync();
    expect(harness.request).toHaveBeenLastCalledWith(SESSION_VIEWERS_SET_METHOD, {
      sessionKeys: ["agent:main:main"],
    });
    store.unwatch(owner);
    await flushSync();
    expect(vi.getTimerCount()).toBe(0);
    const detachedCount = harness.request.mock.calls.length;
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("keydown"));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(harness.request).toHaveBeenCalledTimes(detachedCount);
  });

  it("stops renewal on disconnect and fences a delayed old-client acknowledgement", async () => {
    vi.useFakeTimers();
    const harness = createGatewayHarness();
    let resolveOld!: (value: unknown) => void;
    harness.request.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveOld = resolve;
      }),
    );
    const store = sessionViewerPresenceForGateway(harness.gateway);
    const owner = {};
    store.watch(owner, ["main"]);
    await flushSync();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(harness.request).toHaveBeenCalledOnce();
    harness.setSnapshot({ ...harness.gateway.snapshot, phase: "reconnecting", hello: null });
    await flushSync();
    expect(vi.getTimerCount()).toBe(0);
    resolveOld({ sessionKeys: ["agent:main:main"] });
    await flushSync();
    harness.setSnapshot({
      ...harness.gateway.snapshot,
      phase: "connected",
      hello: createHello("agent:main:new"),
    });
    await flushSync();
    expect(harness.request).toHaveBeenLastCalledWith(SESSION_VIEWERS_SET_METHOD, {
      sessionKeys: ["agent:main:new"],
    });
    store.unwatch(owner);
    await flushSync();
    expect(vi.getTimerCount()).toBe(0);
  });
});
