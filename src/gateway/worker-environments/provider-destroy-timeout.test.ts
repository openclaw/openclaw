import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import * as support from "./service.test-support.js";

async function prepareEntrance(entrance: "destroy" | "bootstrap-failure", id: string) {
  if (entrance === "destroy") {
    await support.seedReady(id);
  } else {
    support.testState.bootstrapWorker = vi.fn(async () => {
      throw new Error("bootstrap failed before admission");
    });
  }
  return (service: ReturnType<typeof support.createService>) =>
    entrance === "destroy"
      ? service.destroy(id)
      : service.createWithRequest({ profileId: "development", idempotencyKey: id });
}

support.setupWorkerEnvironmentServiceSuite();

it.for([
  ["destroy", false],
  ["bootstrap-failure", false],
  ["destroy", true],
] as const)(
  "selects the teardown deadline during %s (service override=%s)",
  async ([entrance, override], { signal }) => {
    const started = createDeferred();
    const finish = createDeferred();
    const destroy = vi.fn(async () => {
      started.resolve();
      // A test timeout does not unwind finally; release provider ownership on cancellation.
      await racePromiseWithAbortSignal(finish.promise, signal);
    });
    const resolveDestroyTimeoutMs = vi.fn(() => {
      if (override) {
        throw new Error("must not evaluate overridden deadline");
      }
      return 10 * 60_000;
    });
    const run = await prepareEntrance(entrance, "slow-destroy");
    const service = support.createService(
      support.createProvider({ destroy, resolveDestroyTimeoutMs }),
      override ? { providerCallTimeoutMs: 1_000 } : undefined,
    );
    // Keep the monotonic clock shared with real SQLite workers on its native epoch.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let settled = false;
    const operation = run(service)
      .catch((error: unknown) => error)
      .finally(() => {
        settled = true;
      });
    try {
      await support.waitForFast(() => started.promise);
      if (!override) {
        await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
        expect(settled).toBe(false);
      }
      finish.resolve();
      const result = await operation;
      expect(resolveDestroyTimeoutMs.mock.calls).toEqual(override ? [] : [[{ region: "test" }]]);
      expect(destroy).toHaveBeenCalledOnce();
      expect(result).toMatchObject(
        entrance === "destroy" ? { state: "destroyed" } : { code: "bootstrap_failure" },
      );
      if (entrance !== "destroy") {
        expect(support.testState.store.list()[0]).toMatchObject({ state: "failed", leaseId: null });
      }
    } finally {
      finish.resolve();
      vi.useRealTimers();
      await operation;
    }
  },
);

it.each([0, 1.5, MAX_TIMER_TIMEOUT_MS + 1])(
  "retains teardown intent without invoking the provider for invalid deadline %s",
  async (timeoutMs) => {
    await support.seedReady("invalid-destroy-timeout");
    const destroy = vi.fn(async () => {});
    const service = support.createService(
      support.createProvider({ destroy, resolveDestroyTimeoutMs: () => timeoutMs }),
    );

    await expect(service.destroy("invalid-destroy-timeout")).rejects.toMatchObject({
      code: "provider_failure",
    });
    expect(destroy).not.toHaveBeenCalled();
    expect(support.testState.store.get("invalid-destroy-timeout")).toMatchObject({
      state: "destroying",
      leaseId: "lease:invalid-destroy-timeout",
      destroyRequestedAtMs: support.testState.nowMs,
      lastError: expect.stringContaining("Worker provider destroy timeout must be an integer"),
    });
  },
);

it("keeps timed-out teardown queued and rejects a stale owner before retry side effects", async ({
  signal,
}) => {
  const initial = await support.seedReady("timed-out-destroy");
  const started = createDeferred();
  const finish = createDeferred();
  const retryQueued = createDeferred();
  const resolveDestroyTimeoutMs = vi.fn(() => {
    if (resolveDestroyTimeoutMs.mock.calls.length === 2) {
      retryQueued.resolve();
    }
    return 20;
  });
  const destroy = vi.fn(async () => {
    started.resolve();
    await racePromiseWithAbortSignal(finish.promise, signal);
  });
  const service = support.createService(
    support.createProvider({ destroy, resolveDestroyTimeoutMs }),
  );
  // Keep the monotonic clock shared with real SQLite workers on its native epoch.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const first = service.destroy(initial.environmentId).catch((error: unknown) => error);
  let second: Promise<unknown> | undefined;
  try {
    await support.waitForFast(() => started.promise);
    await vi.advanceTimersByTimeAsync(21);
    expect(await first).toMatchObject({ code: "provider_failure" });
    expect(support.testState.store.get(initial.environmentId)?.lastError).toBe(
      "Worker provider operation timed out after 20ms",
    );

    await expect(service.requestDestroy(initial.environmentId)).rejects.toMatchObject({
      code: "invalid_state",
      message: expect.stringContaining("Worker provider operation timed out after 20ms"),
    });
    expect(resolveDestroyTimeoutMs).toHaveBeenCalledOnce();
    expect(destroy).toHaveBeenCalledOnce();

    second = service.destroy(initial.environmentId).catch((error: unknown) => error);
    await retryQueued.promise;
    expect(resolveDestroyTimeoutMs).toHaveBeenCalledTimes(2);
    expect(destroy).toHaveBeenCalledOnce();
    await support.testState.store.transition({
      environmentId: initial.environmentId,
      from: "destroying",
      to: "destroyed",
    });
    finish.resolve();
    expect(await second).toBeInstanceOf(Error);
    expect(support.testState.store.get(initial.environmentId)).toMatchObject({
      state: "destroyed",
    });
    expect(destroy).toHaveBeenCalledOnce();
  } finally {
    finish.resolve();
    vi.useRealTimers();
    await first;
    await second;
  }
});
