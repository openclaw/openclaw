import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayPendingRequests } from "../../../packages/gateway-client/src/pending-request.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import {
  createGatewayHarness,
  createHello,
  flushSync,
} from "./session-pull-requests.test-support.ts";
import { sessionPullRequestsForGateway } from "./session-pull-requests.ts";

function createPendingHarness() {
  const harness = createGatewayHarness();
  const ids: string[] = [];
  const retired: string[] = [];
  const pending = new GatewayPendingRequests({
    createRequestId: () => "pull-requests",
    nowMs: () => Date.now(),
    onTiming: ({ errorCode }) => {
      if (errorCode) {
        retired.push(errorCode);
      }
    },
  });
  harness.request.mockImplementation((method, params, options) =>
    pending.request({ send: () => undefined }, method, params, {
      ...options,
      onSent: (id) => ids.push(id),
    }),
  );
  return {
    ...harness,
    pending,
    retired,
    acknowledge(index: number) {
      pending.handleResponse({ type: "res", id: ids[index]!, ok: true, payload: {} });
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
});

describe("pull request subscription acknowledgment lifetime", () => {
  it("retains a forced refresh while the connected gateway temporarily omits the capability", async () => {
    vi.useFakeTimers();
    const harness = createPendingHarness();
    const store = sessionPullRequestsForGateway(harness.gateway);
    const owner = {};
    const key = "agent:main:demo";
    try {
      store.watch(owner, [key]);
      await flushSync();
      harness.acknowledge(0);
      await flushSync();
      store.refresh(key);
      await flushSync();
      expect(harness.request.mock.calls[1]?.[1]).toEqual({
        sessionKeys: [key],
        refreshSessionKeys: [key],
      });
      const refreshSignal = harness.request.mock.calls[1]?.[2]?.signal;

      harness.setSnapshot({
        ...harness.gateway.snapshot,
        hello: { ...createHello(), features: { methods: [] } },
      });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(refreshSignal?.aborted).toBe(true);
      expect(harness.retired).toEqual(["CLIENT_ABORTED"]);
      expect(harness.pending.hasPending).toBe(false);
      expect(harness.request).toHaveBeenCalledTimes(2);

      harness.setSnapshot({ ...harness.gateway.snapshot, hello: createHello() });
      await flushSync();
      expect(harness.request.mock.calls[2]?.[1]).toEqual({
        sessionKeys: [key],
        refreshSessionKeys: [key],
      });
      harness.acknowledge(1);
      expect(harness.pending.hasPending).toBe(true);
      harness.acknowledge(2);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(harness.request).toHaveBeenCalledTimes(3);
      expect(harness.pending.hasPending).toBe(false);
      store.unwatch(owner);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      harness.setSnapshot({ ...harness.gateway.snapshot, phase: "stopped", hello: null });
      store.unwatch(owner);
      harness.pending.flush(new Error("test complete"));
      await flushSync();
    }
  });

  it("retires a lost refresh acknowledgment and retries retained coalesced intent once", async () => {
    vi.useFakeTimers();
    const harness = createPendingHarness();
    const store = sessionPullRequestsForGateway(harness.gateway);
    const owner = {};
    const key = "agent:main:demo";
    try {
      store.watch(owner, [key]);
      await flushSync();
      harness.acknowledge(0);
      await flushSync();
      store.refresh(key);
      await flushSync();
      for (let hint = 0; hint < 3; hint += 1) {
        store.refresh(key);
        await flushSync();
      }
      expect(harness.request).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(30_000);
      expect(harness.pending.hasPending).toBe(false);
      expect(harness.retired).toEqual(["CLIENT_TIMEOUT"]);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(harness.request).toHaveBeenCalledTimes(3);
      expect(harness.request.mock.calls[2]?.[1]).toEqual({
        sessionKeys: [key],
        refreshSessionKeys: [key],
      });
      harness.acknowledge(1);
      expect(harness.pending.hasPending).toBe(true);
      harness.acknowledge(2);
      await flushSync();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(harness.request).toHaveBeenCalledTimes(3);
      expect(harness.pending.hasPending).toBe(false);

      store.unwatch(owner);
      expect(harness.request.mock.calls[3]?.[1]).toEqual({ sessionKeys: [] });
      expect(harness.unsubscribeSnapshots).toHaveBeenCalledOnce();
      expect(harness.unsubscribeEvents).toHaveBeenCalledOnce();
      expect(harness.pending.hasPending).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      harness.setSnapshot({ ...harness.gateway.snapshot, phase: "stopped", hello: null });
      store.unwatch(owner);
      harness.pending.flush(new Error("test complete"));
      await flushSync();
    }
  });

  it("settles a one-shot load after a lost acknowledgment and sends its final empty set", async () => {
    vi.useFakeTimers();
    const harness = createPendingHarness();
    const store = sessionPullRequestsForGateway(harness.gateway);
    const owner = {};
    const settled = vi.fn();
    try {
      void store.load(owner, "agent:main:demo").then(settled);
      await flushSync();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(settled).toHaveBeenCalledExactlyOnceWith(undefined);
      expect(harness.request).toHaveBeenCalledTimes(2);
      expect(harness.request.mock.calls[1]?.[1]).toEqual({ sessionKeys: [] });
      expect(harness.retired).toEqual(["CLIENT_TIMEOUT", "CLIENT_ABORTED"]);
      expect(harness.pending.hasPending).toBe(false);
      expect(harness.unsubscribeSnapshots).toHaveBeenCalledOnce();
      expect(harness.unsubscribeEvents).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      store.unwatch(owner);
      harness.pending.flush(new Error("test complete"));
      await flushSync();
    }
  });

  it.each(["membership", "hello", "client", "unavailable", "hidden", "unwatch"] as const)(
    "retires a pending declaration on %s without reviving a stale retry",
    async (change) => {
      vi.useFakeTimers();
      const harness = createPendingHarness();
      const store = sessionPullRequestsForGateway(harness.gateway);
      const owner = {};
      try {
        store.watch(owner, ["agent:main:demo"]);
        await flushSync();
        const firstSignal = harness.request.mock.calls[0]?.[2]?.signal;
        harness.setSnapshot({ ...harness.gateway.snapshot });
        document.dispatchEvent(new Event("visibilitychange"));
        await flushSync();
        expect(harness.request).toHaveBeenCalledOnce();
        expect(firstSignal?.aborted).toBe(false);

        if (change === "membership") {
          store.watch(owner, ["agent:main:replacement"]);
        } else if (change === "hidden") {
          Object.defineProperty(document, "visibilityState", {
            configurable: true,
            value: "hidden",
          });
          document.dispatchEvent(new Event("visibilitychange"));
        } else if (change === "unwatch") {
          store.unwatch(owner);
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
        expect(harness.retired).toEqual(
          change === "unwatch" ? ["CLIENT_ABORTED", "CLIENT_ABORTED"] : ["CLIENT_ABORTED"],
        );
        if (change !== "unavailable") {
          expect(harness.request).toHaveBeenCalledTimes(2);
          if (change === "hidden" || change === "unwatch") {
            expect(harness.request.mock.calls[1]?.[1]).toEqual({ sessionKeys: [] });
          }
          harness.acknowledge(1);
        }
        harness.acknowledge(0);
        await flushSync();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(harness.request).toHaveBeenCalledTimes(change === "unavailable" ? 1 : 2);
        expect(harness.pending.hasPending).toBe(false);
        store.unwatch(owner);
        expect(harness.pending.hasPending).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        harness.setSnapshot({ ...harness.gateway.snapshot, phase: "stopped", hello: null });
        store.unwatch(owner);
        harness.pending.flush(new Error("test complete"));
        await flushSync();
      }
    },
  );
});
