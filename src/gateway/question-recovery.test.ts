import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SessionAccessScope } from "../config/sessions/session-accessor.types.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { createQuestionRecovery } from "./question-recovery.js";

let clock: ReturnType<typeof createGatewaySchedulerClock>;
let scheduler: ReturnType<typeof createTestGatewayScheduler>;
beforeEach(() => {
  clock = createGatewaySchedulerClock();
  scheduler = createTestGatewayScheduler(clock.clock);
});
afterEach(async () => {
  await scheduler.stop();
});
const a: SessionAccessScope = {
  agentId: "a",
  storePath: "/a/sessions.db",
  sessionKey: "agent:a:main",
};
const b: SessionAccessScope = {
  agentId: "b",
  storePath: "/b/sessions.db",
  sessionKey: "agent:b:main",
};
function owner(
  discover: () => Promise<readonly SessionAccessScope[]>,
  recover: (scope: SessionAccessScope) => Promise<void>,
) {
  return createQuestionRecovery({
    scheduler,
    discover: async () => ({ scopes: await discover() }),
    recover,
    assertCurrent: () => {},
    track: (run) => Promise.resolve().then(run),
    warn: vi.fn(),
  });
}

it("retries discovery failure under the same Gateway scheduler", async () => {
  const discover = vi
    .fn()
    .mockRejectedValueOnce(new Error("temporary discovery failure"))
    .mockResolvedValue([a]);
  const recover = vi.fn(async () => {});
  const runtime = owner(discover, recover);
  await runtime.recover();
  expect(recover).not.toHaveBeenCalled();
  await clock.advanceBy(1_000);
  expect(discover).toHaveBeenCalledTimes(2);
  expect(recover).toHaveBeenCalledWith(a);
  await runtime.stop();
});

it("restores healthy siblings and retries only the unfinished store", async () => {
  let unavailable = true;
  const recover = vi.fn(async (scope: SessionAccessScope) => {
    if (scope.agentId === "a" && unavailable) {
      throw new Error("corrupt store");
    }
  });
  const runtime = owner(async () => [a, b], recover);
  await runtime.recover();
  expect(recover.mock.calls.map(([scope]) => scope.agentId)).toEqual(["a", "b"]);
  unavailable = false;
  await clock.advanceBy(1_000);
  expect(recover.mock.calls.map(([scope]) => scope.agentId)).toEqual(["a", "b", "a"]);
  expect(scheduler.nextWakeAtMs).toBeNull();
  await runtime.stop();
});

it("deduplicates concurrent passes and permits a later pass after failure", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const discover = vi
    .fn()
    .mockImplementationOnce(async () => {
      await gate;
      throw new Error("temporary");
    })
    .mockResolvedValue([a]);
  const recover = vi.fn(async () => {});
  const runtime = owner(discover, recover);
  const first = runtime.recover();
  expect(runtime.recover()).toBe(first);
  release();
  await first;
  await runtime.recover();
  expect(discover).toHaveBeenCalledTimes(2);
  expect(recover).toHaveBeenCalledOnce();
  expect(scheduler.nextWakeAtMs).toBeNull();
  await runtime.stop();
});

it("cancels pending retries synchronously and joins an in-flight recovery on close", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const admitted = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const recover = vi.fn(async () => {
    entered();
    await gate;
  });
  const runtime = owner(async () => [a], recover);
  const running = runtime.recover();
  await admitted;
  runtime.beginClose();
  let joined = false;
  const stopping = runtime.stop().then(() => {
    joined = true;
  });
  await Promise.resolve();
  expect(joined).toBe(false);
  release();
  await running;
  await stopping;
  expect(joined).toBe(true);
  expect(scheduler.nextWakeAtMs).toBeNull();
  await clock.advanceBy(60_000);
  expect(recover).toHaveBeenCalledOnce();
});

it("keeps healthy recovery and retry ownership when warning delivery throws", async () => {
  let unavailable = true;
  const recover = vi.fn(async (scope: SessionAccessScope) => {
    if (scope.agentId === "a" && unavailable) {
      throw new Error("unavailable store");
    }
  });
  const runtime = createQuestionRecovery({
    scheduler,
    discover: async () => ({ scopes: [a, b] }),
    recover,
    assertCurrent: () => {},
    track: (run) => Promise.resolve().then(run),
    warn: () => {
      throw new Error("logger failed");
    },
  });
  await runtime.recover();
  expect(recover.mock.calls.map(([scope]) => scope.agentId)).toEqual(["a", "b"]);
  unavailable = false;
  await clock.advanceBy(1_000);
  expect(recover.mock.calls.map(([scope]) => scope.agentId)).toEqual(["a", "b", "a"]);
  await runtime.stop();
});

it("rediscovers an excluded pending agent after admission without holding healthy recovery", async () => {
  const preparation = createDeferredCore();
  const restored = createDeferredCore();
  let pending = true;
  const discover = vi.fn(async () => (pending ? [b] : [a, b]));
  const recover = vi.fn(async (scope: SessionAccessScope) => {
    if (scope === a) {
      restored.resolve();
    }
  });
  const runtime = createQuestionRecovery({
    scheduler,
    discover: async () => ({ scopes: await discover() }),
    recover,
    pendingPreparation: () => (pending ? preparation.promise : undefined),
    assertCurrent: () => {},
    track: (run) => Promise.resolve().then(run),
    warn: vi.fn(),
  });
  // This pass must return before readiness: startup publishes readiness afterward.
  await runtime.recover();
  expect(recover.mock.calls.map(([scope]) => scope.agentId)).toEqual(["b"]);
  expect(scheduler.nextWakeAtMs).toBeNull();
  pending = false;
  preparation.resolve();
  await restored.promise;
  await runtime.stop();
  expect(discover).toHaveBeenCalledTimes(2);
  expect(recover.mock.calls.map(([scope]) => scope.agentId)).toEqual(["b", "a"]);
});

it("cancels admission readiness observation on close without waiting for preparation", async () => {
  const preparation = createDeferredCore();
  const discover = vi.fn(async () => []);
  const runtime = createQuestionRecovery({
    scheduler,
    discover: async () => ({ scopes: await discover() }),
    recover: vi.fn(async () => {}),
    pendingPreparation: () => preparation.promise,
    assertCurrent: () => {},
    track: (run) => Promise.resolve().then(run),
    warn: vi.fn(),
  });
  await runtime.recover();
  await runtime.stop();
  expect(discover).toHaveBeenCalledOnce();
  expect(scheduler.nextWakeAtMs).toBeNull();
});

it("joins delayed admission and its full rediscovery without holding initial startup", async () => {
  const preparation = createDeferredCore();
  const entered = createDeferredCore();
  const restored = createDeferredCore();
  let pending = true;
  const discover = vi.fn(async () => (pending ? [b] : [a, b]));
  const recover = vi.fn(async (scope: SessionAccessScope) => {
    if (scope === a) {
      entered.resolve();
      await restored.promise;
    }
  });
  const runtime = createQuestionRecovery({
    scheduler,
    discover: async () => ({ scopes: await discover() }),
    recover,
    pendingPreparation: () => preparation.promise,
    assertCurrent: () => {},
    track: (run) => Promise.resolve().then(run),
    warn: vi.fn(),
  });
  await runtime.recover();
  let ready = false;
  const waiting = runtime.waitForRecovery().then(() => {
    ready = true;
  });
  await Promise.resolve();
  expect(ready).toBe(false);
  pending = false;
  preparation.resolve();
  await entered.promise;
  expect(ready).toBe(false);
  restored.resolve();
  await waiting;
  expect(recover.mock.calls.map(([scope]) => scope.agentId)).toEqual(["b", "a"]);
  // Returning the same settled preparation promise cannot start another observer.
  const discoveries = discover.mock.calls.length;
  await runtime.waitForRecovery();
  expect(discover).toHaveBeenCalledTimes(discoveries);
  expect(recover.mock.calls.map(([scope]) => scope.agentId)).toEqual(["b", "a"]);
  await runtime.stop();
});

it.each(["discovery", "store", "preparation"] as const)(
  "reports unresolved %s failure instead of declaring custody absent",
  async (failure) => {
    const error = new Error(`${failure} unavailable`);
    const preparation = createDeferredCore();
    let available = false;
    const runtime = createQuestionRecovery({
      scheduler,
      discover: async () => {
        if (failure === "discovery" && !available) {
          throw error;
        }
        return { scopes: [a] };
      },
      recover: async () => {
        if (failure === "store" && !available) {
          throw error;
        }
      },
      pendingPreparation: () => (failure === "preparation" ? preparation.promise : undefined),
      assertCurrent: () => {},
      track: (run) => Promise.resolve().then(run),
      warn: vi.fn(),
    });
    await runtime.recover();
    const waiting = runtime.waitForRecovery();
    if (failure === "preparation") {
      preparation.reject(error);
    }
    await expect(waiting).rejects.toMatchObject({ errors: expect.arrayContaining([error]) });
    if (failure !== "preparation") {
      available = true;
      await clock.advanceBy(2_000);
      await runtime.waitForRecovery();
      expect(scheduler.nextWakeAtMs).toBeNull();
    }
    await runtime.stop();
  },
);

it("aborts missing-custody readiness on Gateway close without waiting for admission", async () => {
  const preparation = createDeferredCore();
  const runtime = createQuestionRecovery({
    scheduler,
    discover: async () => ({ scopes: [] }),
    recover: vi.fn(async () => {}),
    pendingPreparation: () => preparation.promise,
    assertCurrent: () => {},
    track: (run) => Promise.resolve().then(run),
    warn: vi.fn(),
  });
  await runtime.recover();
  const waiting = runtime.waitForRecovery();
  const rejected = expect(waiting).rejects.toThrow();
  runtime.beginClose();
  await rejected;
  await runtime.stop();
});
