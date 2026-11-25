import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.ts";
import type { GatewayBrowserClient, GatewayHelloOk } from "../api/gateway.ts";
import { pendingSetRequests, watchedGateway } from "./gateway-stores.test-support.ts";
import { sessionViewerPresenceForGateway } from "./session-viewer-presence.ts";

const SESSION_VIEWERS_SET_METHOD = "sessions.viewers.set";
const cleanups: Array<() => Promise<void>> = [];

function createHello(mainSessionKey = "agent:main:main"): GatewayHelloOk {
  return {
    type: "hello-ok",
    protocol: 1,
    auth: { role: "operator", scopes: [] },
    features: { methods: [SESSION_VIEWERS_SET_METHOD] },
    snapshot: { sessionDefaults: { defaultAgentId: "main", mainKey: "main", mainSessionKey } },
  };
}

function createGatewayHarness() {
  const request = vi.fn<GatewayBrowserClient["request"]>().mockResolvedValue({ sessionKeys: [] });
  const {
    gateway,
    publish: setSnapshot,
    unsubscribe,
  } = watchedGateway({
    client: { request } as unknown as GatewayBrowserClient,
    hello: createHello(),
  });
  const store = sessionViewerPresenceForGateway(gateway);
  return { gateway, request, unsubscribe, setSnapshot, store, owner: {} };
}

function createPendingGatewayHarness() {
  const harness = createGatewayHarness();
  const requests = pendingSetRequests(harness.request, "viewer");
  cleanups.push(async () => {
    harness.setSnapshot({ ...harness.gateway.snapshot, phase: "stopped", hello: null });
    harness.store.unwatch(harness.owner);
    requests.pending.flush(new Error("test complete"));
    await flushSync();
  });
  return {
    ...harness,
    ...requests,
  };
}

async function flushSync() {
  await Promise.resolve();
  await Promise.resolve();
}

function expectDeclaration(
  harness: ReturnType<typeof createGatewayHarness>,
  sessionKeys: string[],
  agentId?: string,
) {
  expect(harness.request).toHaveBeenLastCalledWith(
    SESSION_VIEWERS_SET_METHOD,
    { ...(agentId ? { agentId } : {}), sessionKeys },
    expect.anything(),
  );
}

async function setVisibility(value: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", { configurable: true, value });
  document.dispatchEvent(new Event("visibilitychange"));
  await flushSync();
}

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  vi.restoreAllMocks();
  vi.useRealTimers();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
});

it("retires lost acknowledgments and retries the final clear before detaching", async () => {
  vi.useFakeTimers();
  const harness = createPendingGatewayHarness();
  const { store, owner } = harness;
  store.watch(owner, ["agent:main:visible"]);
  await flushSync();

  await vi.advanceTimersByTimeAsync(30_000);
  expect(harness.pending.hasPending).toBe(false);
  expect(harness.retired).toEqual(["CLIENT_TIMEOUT"]);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(harness.request).toHaveBeenCalledTimes(2);
  harness.acknowledge(1);
  await flushSync();
  expect(harness.pending.hasPending).toBe(false);

  store.unwatch(owner);
  await flushSync();
  expect(harness.unsubscribe).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(harness.pending.hasPending).toBe(false);
  harness.acknowledge(0);
  harness.acknowledge(2);
  await flushSync();
  expect(harness.unsubscribe).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(harness.request).toHaveBeenCalledTimes(4);
  expect(harness.request.mock.calls[3]?.[1]).toEqual({ sessionKeys: [] });
  harness.acknowledge(3);
  await flushSync();
  expect(harness.unsubscribe).toHaveBeenCalledOnce();
  expect(harness.pending.hasPending).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});

it.each([false, true])(
  "coalesces same-turn viewer redeclarations with acknowledged=%s",
  async (acknowledged) => {
    const harness = createPendingGatewayHarness();
    const { store, owner } = harness;
    store.watch(owner, ["agent:main:visible"]);
    await flushSync();
    if (acknowledged) {
      harness.acknowledge(0);
      await flushSync();
    }

    store.unwatch(owner);
    store.watch(owner, ["agent:main:visible"]);
    await flushSync();
    expect(harness.request).toHaveBeenCalledOnce();
    expect(harness.retired).toEqual([]);

    // A populated acknowledgment queued before the clear cannot detach it.
    if (!acknowledged) {
      harness.acknowledge(0);
    }
    store.unwatch(owner);
    await flushSync();
    expect(harness.request).toHaveBeenCalledTimes(2);
    expectDeclaration(harness, []);
    expect(harness.unsubscribe).not.toHaveBeenCalled();

    harness.acknowledge(1);
    await flushSync();
    expect(harness.unsubscribe).toHaveBeenCalledOnce();
    expect(harness.pending.hasPending).toBe(false);
  },
);

it.each(["membership", "hello", "client", "unavailable"] as const)(
  "retires a pending declaration on %s without reviving stale retries",
  async (change) => {
    vi.useFakeTimers();
    const harness = createPendingGatewayHarness();
    const { store, owner } = harness;
    store.watch(owner, ["agent:main:visible"]);
    await flushSync();
    const firstSignal = harness.request.mock.calls[0]?.[2]?.signal;

    // Same-signature snapshots and visibility events must keep this attempt.
    harness.setSnapshot({ ...harness.gateway.snapshot });
    document.dispatchEvent(new Event("visibilitychange"));
    await flushSync();
    expect(harness.request).toHaveBeenCalledOnce();
    expect(firstSignal?.aborted).toBe(false);

    if (change === "membership") {
      store.watch(owner, ["agent:main:replacement"]);
    } else {
      harness.setSnapshot({
        ...harness.gateway.snapshot,
        ...(change === "hello" ? { hello: createHello() } : {}),
        ...(change === "client"
          ? { client: { request: harness.request } as unknown as GatewayBrowserClient }
          : {}),
        ...(change === "unavailable" ? { phase: "reconnecting", hello: null } : {}),
      });
    }
    await flushSync();
    expect(firstSignal?.aborted).toBe(true);
    expect(harness.retired).toEqual(["CLIENT_ABORTED"]);
    if (change !== "unavailable") {
      expect(harness.request).toHaveBeenCalledTimes(2);
      harness.acknowledge(1);
    }
    harness.acknowledge(0);
    await flushSync();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.request).toHaveBeenCalledTimes(change === "unavailable" ? 1 : 2);
    expect(harness.pending.hasPending).toBe(false);
    store.unwatch(owner);
    await flushSync();
    if (change !== "unavailable") {
      harness.acknowledge(2);
    }
    await flushSync();
    expect(harness.unsubscribe).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  },
);

it("declares the bounded union and replaces it as panes switch or close", async () => {
  const harness = createGatewayHarness();
  const { store } = harness;
  const firstPane = {};
  const secondPane = {};

  store.watch(firstPane, ["main"]);
  store.watch(secondPane, ["agent:main:other"]);
  await flushSync();
  expectDeclaration(harness, ["agent:main:main", "agent:main:other"]);

  store.watch(firstPane, ["agent:main:replacement"]);
  await flushSync();
  expectDeclaration(harness, ["agent:main:other", "agent:main:replacement"]);

  store.unwatch(secondPane);
  await flushSync();
  expectDeclaration(harness, ["agent:main:replacement"]);

  store.unwatch(firstPane);
  await flushSync();
  expectDeclaration(harness, []);
  expect(harness.unsubscribe).toHaveBeenCalledOnce();
});

it("threads the selected owner for a bare global viewer identity", async () => {
  const harness = createGatewayHarness();
  harness.setSnapshot({
    ...harness.gateway.snapshot,
    assistantAgentId: "work",
    hello: createHello("global"),
  });
  const { store, owner } = harness;
  store.watch(owner, ["global"]);
  await flushSync();

  expectDeclaration(harness, ["global"], "work");
  store.unwatch(owner);
  await flushSync();
});

it("declares empty while hidden and restores the set when visible", async () => {
  const harness = createGatewayHarness();
  const { store, owner } = harness;
  store.watch(owner, ["agent:main:visible"]);
  await flushSync();

  await setVisibility("hidden");
  expectDeclaration(harness, []);

  await setVisibility("visible");
  expectDeclaration(harness, ["agent:main:visible"]);
  store.unwatch(owner);
  await flushSync();
});

it("does not treat an older empty acknowledgement as the current final clear", async () => {
  vi.useFakeTimers();
  const harness = createGatewayHarness();
  const { store, owner } = harness;
  store.watch(owner, ["agent:main:visible"]);
  await flushSync();

  await setVisibility("hidden");

  const visible = createDeferred<{ sessionKeys: string[] }>();
  const finalClear = createDeferred<never>();
  harness.request.mockReturnValueOnce(visible.promise).mockReturnValueOnce(finalClear.promise);
  await setVisibility("visible");
  store.unwatch(owner);
  await flushSync();
  expect(harness.request).toHaveBeenCalledTimes(4);

  document.dispatchEvent(new Event("visibilitychange"));
  await flushSync();
  expect(harness.unsubscribe).not.toHaveBeenCalled();

  visible.resolve({ sessionKeys: ["agent:main:visible"] });
  finalClear.reject(new Error("final clear temporarily unavailable"));
  await flushSync();
  await vi.advanceTimersByTimeAsync(30_000);
  await flushSync();

  expect(harness.request).toHaveBeenCalledTimes(5);
  expectDeclaration(harness, []);
  expect(harness.unsubscribe).toHaveBeenCalledOnce();
});
