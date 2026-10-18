import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayPendingRequests } from "../../../packages/gateway-client/src/pending-request.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { pendingSetRequests } from "./gateway-stores.test-support.ts";
import {
  createGatewayHarness,
  createHello,
  flushSync,
} from "./session-pull-requests.test-support.ts";
import { sessionPullRequestsForGateway } from "./session-pull-requests.ts";

let harness: ReturnType<typeof createGatewayHarness>;
let store: ReturnType<typeof sessionPullRequestsForGateway>;
let owner: object;
let pending: GatewayPendingRequests;
let retired: string[];
let acknowledge: ReturnType<typeof pendingSetRequests>["acknowledge"];
const key = "agent:main:demo";

beforeEach(() => {
  vi.useFakeTimers();
  harness = createGatewayHarness();
  store = sessionPullRequestsForGateway(harness.gateway);
  owner = {};
  ({ pending, retired, acknowledge } = pendingSetRequests(harness.request, "pull-requests"));
});

const params = (index: number) => harness.request.mock.calls[index]?.[1];
function hello(value = createHello()) {
  harness.setSnapshot({ ...harness.gateway.snapshot, hello: value });
}

async function startRefresh() {
  store.watch(owner, [key]);
  await flushSync();
  acknowledge(0);
  await flushSync();
  store.refresh(key);
  await flushSync();
}

function expectDetached() {
  expect(harness.unsubscribeSnapshots).toHaveBeenCalledOnce();
  expect(harness.unsubscribeEvents).toHaveBeenCalledOnce();
  expect(pending.hasPending).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
}

afterEach(async () => {
  harness.setSnapshot({ ...harness.gateway.snapshot, phase: "stopped", hello: null });
  store.unwatch(owner);
  pending.flush(new Error("test complete"));
  await flushSync();
  vi.restoreAllMocks();
  vi.useRealTimers();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
});

describe("pull request subscription acknowledgment lifetime", () => {
  it("retains refresh and unsubscribe intent while the connected gateway omits the capability", async () => {
    await startRefresh();
    expect(params(1)).toEqual({ sessionKeys: [key], refreshSessionKeys: [key] });
    const refreshSignal = harness.request.mock.calls[1]?.[2]?.signal;

    hello({ ...createHello(), features: { methods: [] } });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refreshSignal?.aborted).toBe(true);
    expect(retired).toEqual(["CLIENT_ABORTED"]);
    expect(pending.hasPending).toBe(false);
    expect(harness.request).toHaveBeenCalledTimes(2);

    hello();
    await flushSync();
    expect(params(2)).toEqual({ sessionKeys: [key], refreshSessionKeys: [key] });
    acknowledge(1);
    expect(pending.hasPending).toBe(true);
    acknowledge(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.request).toHaveBeenCalledTimes(3);
    expect(pending.hasPending).toBe(false);
    const passiveOwner = {};
    store.watch(passiveOwner, [key], { passive: true });
    hello({ ...createHello(), features: { methods: [] } });
    await flushSync();
    store.unwatch(owner);
    hello();
    await flushSync();
    expect(params(3)).toEqual({ sessionKeys: [] });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.request).toHaveBeenCalledTimes(5);
    expect(params(4)).toEqual({ sessionKeys: [] });
    acknowledge(4);
    await flushSync();
    hello({ ...createHello(), features: { methods: [] } });
    await flushSync();
    hello();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.request).toHaveBeenCalledTimes(5);
    store.unwatch(passiveOwner);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retires a lost refresh acknowledgment and retries retained coalesced intent once", async () => {
    await startRefresh();
    for (let hint = 0; hint < 3; hint += 1) {
      store.refresh(key);
      await flushSync();
    }
    expect(harness.request).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(pending.hasPending).toBe(false);
    expect(retired).toEqual(["CLIENT_TIMEOUT"]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(harness.request).toHaveBeenCalledTimes(3);
    expect(params(2)).toEqual({ sessionKeys: [key], refreshSessionKeys: [key] });
    acknowledge(1);
    expect(pending.hasPending).toBe(true);
    acknowledge(2);
    await flushSync();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.request).toHaveBeenCalledTimes(3);
    expect(pending.hasPending).toBe(false);

    store.unwatch(owner);
    expect(params(3)).toEqual({ sessionKeys: [] });
    expectDetached();
  });

  it("settles a one-shot load after a lost acknowledgment and sends its final empty set", async () => {
    const settled = vi.fn();
    void store.load(owner, key).then(settled);
    await flushSync();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(settled).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(harness.request).toHaveBeenCalledTimes(2);
    expect(params(1)).toEqual({ sessionKeys: [] });
    expect(retired).toEqual(["CLIENT_TIMEOUT", "CLIENT_ABORTED"]);
    expectDetached();
  });

  it.each(["membership", "hello", "client", "unavailable", "hidden", "unwatch"] as const)(
    "retires a pending declaration on %s without reviving a stale retry",
    async (change) => {
      store.watch(owner, [key]);
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
        Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
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
      expect(retired).toEqual(
        change === "unwatch" ? ["CLIENT_ABORTED", "CLIENT_ABORTED"] : ["CLIENT_ABORTED"],
      );
      if (change !== "unavailable") {
        expect(harness.request).toHaveBeenCalledTimes(2);
        if (change === "hidden" || change === "unwatch") {
          expect(params(1)).toEqual({ sessionKeys: [] });
        }
        acknowledge(1);
      }
      acknowledge(0);
      await flushSync();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(harness.request).toHaveBeenCalledTimes(change === "unavailable" ? 1 : 2);
      expect(pending.hasPending).toBe(false);
      store.unwatch(owner);
      expect(pending.hasPending).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});
