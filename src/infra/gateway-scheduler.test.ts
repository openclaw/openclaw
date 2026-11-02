import { AsyncLocalStorage, createHook } from "node:async_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { queryObjects } from "node:v8";
import { describe, expect, it, vi } from "vitest";
import { withSessionTurn } from "../sessions/session-controller.admission.js";
import type { ReplyOperation } from "../sessions/session-controller.contracts.js";
import { trackAsyncWork } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { GatewayScheduler } from "./gateway-scheduler.js";

type Job = Parameters<GatewayScheduler["schedule"]>[0];
type JobTiming = Omit<Job, "id" | "run"> & ({ atMs: number } | { delayMs: number });
function expectCalls(...calls: Array<[unknown, number]>) {
  for (const [run, count] of calls) {
    expect(run).toHaveBeenCalledTimes(count);
  }
}
const schedulerLog = vi.hoisted(() => ({
  debug: vi.fn(),
  trace: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  // Session-controller diagnostics share this mocked subsystem logger.
  isEnabled: () => false,
}));
vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => schedulerLog,
}));

function fixture() {
  const time = createGatewaySchedulerClock(1_000);
  const scheduler = createTestGatewayScheduler(time.clock);
  const job = (
    id: string,
    timing: JobTiming,
    run: Job["run"] = vi.fn(),
    owner: Pick<GatewayScheduler, "schedule"> = scheduler,
  ) => {
    owner.schedule({ id, ...timing, run });
    return run;
  };
  const at = async (ms: number, ...calls: Array<[unknown, number]>) => {
    await time.advanceTo(ms);
    expectCalls(...calls);
  };
  return { time, scheduler, job, at };
}

function withNativeErrorStacks<T>(run: () => T): T {
  const prepareStackTrace = Object.getOwnPropertyDescriptor(Error, "prepareStackTrace");
  try {
    // Vite's formatter closures can retain native callsites beyond the closing call.
    Reflect.deleteProperty(Error, "prepareStackTrace");
    return run();
  } finally {
    if (prepareStackTrace) {
      Object.defineProperty(Error, "prepareStackTrace", prepareStackTrace);
    } else {
      Reflect.deleteProperty(Error, "prepareStackTrace");
    }
  }
}

describe("Gateway timed work", () => {
  it("shares maintenance slots across owners and skips slots missed by async work and sleep", async () => {
    const { time, scheduler, job, at } = fixture();
    const scope = scheduler.scope();
    const gate = createDeferredCore();
    const first = vi.fn(() => gate.promise);
    const second = vi.fn();
    job("first", { delayMs: 30_000, everyMs: 30_000, phase: "maintenance" }, first);
    await time.advanceBy(2_000);
    job("second", { delayMs: 30_000, everyMs: 30_000, phase: "maintenance" }, second, scope);
    expect(scheduler.nextWakeAtMs).toBe(30_000);
    const wake = time.advanceTo(30_000);
    expectCalls([first, 1], [second, 1]);
    await at(95_000, [first, 1], [second, 2]);
    gate.resolve();
    await wake;
    expect(scheduler.nextWakeAtMs).toBe(120_000);
    await scope.stop();
    await at(120_000, [first, 2], [second, 2]);
    await scheduler.stop();
  });

  it("leaves exact expiry and liveness cadences outside the maintenance phase", async () => {
    const { scheduler, job, at } = fixture();
    job("maintenance", { delayMs: 30_000, everyMs: 30_000, phase: "maintenance" });
    const expiry = job("expiry", { atMs: 31_001 });
    const keepalive = job("keepalive", { delayMs: 25_000, everyMs: 25_000 });
    await at(26_000, [keepalive, 1]);
    await at(30_000, [expiry, 0]);
    await at(31_001, [expiry, 1]);
    expect(scheduler.nextWakeAtMs).toBe(51_000);
    await scheduler.stop();
  });

  it("runs a maintenance slot once when the wall clock drifts ahead of elapsed time", async () => {
    const { time, scheduler, job } = fixture();
    const run = job("maintenance", { delayMs: 30_000, everyMs: 30_000, phase: "maintenance" });
    time.setTime(2_001);
    // Any later schedule re-arms the host timer on the earlier wall-clock slot.
    scheduler.schedule({ id: "later", delayMs: 600_000, run: () => {} });
    await time.advanceBy(27_999);
    expect(run).toHaveBeenCalledOnce();
    await time.advanceBy(1_001);
    expect(run).toHaveBeenCalledOnce();
    await time.advanceBy(28_999);
    expect(run).toHaveBeenCalledTimes(2);
    await scheduler.stop();
  });

  it.each(["root", "scope", "scope-after-parent"] as const)(
    "releases the retiring caller while its %s abort signal remains reachable",
    async (kind) => {
      class RetiredOwner {
        close() {
          const { scheduler } = fixture();
          const owner = kind === "root" ? scheduler : scheduler.scope();
          if (kind === "scope-after-parent") {
            scheduler.beginClose();
          }
          owner.beginClose();
          return owner;
        }
      }
      const owners = withNativeErrorStacks(() =>
        Array.from({ length: 12 }, () => new RetiredOwner().close()),
      );
      // Collect after the closing call's execution frame has unwound.
      await nextTurn();
      expect(queryObjects(RetiredOwner)).toBe(0);
      for (const owner of owners) {
        expect(owner.signal).toMatchObject({ aborted: true, reason: { name: "AbortError" } });
      }
    },
  );

  it("does not wake or allocate async resources before a fractional deadline", async () => {
    const time = createGatewaySchedulerClock(1_000);
    let wakes = 0;
    const scheduler = new GatewayScheduler({
      clock: {
        ...time.clock,
        arm: (run, delayMs) =>
          time.clock.arm(() => {
            wakes += 1;
            return run();
          }, Math.trunc(delayMs)),
      },
    });
    const run = vi.fn();
    scheduler.schedule({ id: "sample", delayMs: 20, everyMs: 20, run });
    void time.advanceBy(0.25);
    time.setTime(1_000);
    // An unrelated registration rearms with 19.75ms left on the elapsed deadline.
    scheduler.schedule({ id: "later", delayMs: 10_000, run: () => {} });
    let allocations = 0;
    const hook = createHook({
      init: () => {
        allocations += 1;
      },
    });
    try {
      hook.enable();
      for (let tick = 0; tick < 19; tick += 1) {
        void time.advanceBy(1);
      }
    } finally {
      hook.disable();
    }
    try {
      expect(wakes).toBe(0);
      expect(allocations).toBe(0);
      await time.advanceBy(1);
      expect(run).toHaveBeenCalledOnce();
      expect(wakes).toBe(1);
    } finally {
      await scheduler.stop();
    }
  });

  it("preserves equal-deadline dispatch order when replacing a waiting registration", async () => {
    const { time, scheduler, job } = fixture();
    const seen: string[] = [];
    const record = (value: string) => () => {
      seen.push(value);
    };
    job("first", { delayMs: 100 }, record("retired"));
    job("second", { delayMs: 100 }, record("second"));
    job("first", { delayMs: 100 }, record("replacement"));
    await time.advanceBy(100);
    expect(seen).toEqual(["replacement", "second"]);
    await scheduler.stop();
  });

  it("closes one scope without canceling a sibling's replacement registration", async () => {
    const { time, scheduler } = fixture();
    const retired = scheduler.scope();
    const active = scheduler.scope();
    const run = vi.fn();
    retired.schedule({ id: "maintenance", delayMs: 100, run });
    active.schedule({ id: "maintenance", delayMs: 200, run });
    await retired.stop();
    retired.schedule({ id: "maintenance", delayMs: 0, run: () => run("retired") });
    expect([retired.signal.aborted, active.signal.aborted]).toEqual([true, false]);
    expect(scheduler.nextWakeAtMs).toBe(1_200);
    await time.advanceTo(1_200);
    expect(run).toHaveBeenCalledExactlyOnceWith();
    await scheduler.stop();
    expect(active.signal.aborted).toBe(true);
  });

  it.each(["root", "scope"] as const)(
    "joins %s descendants and replaced callbacks while unrelated jobs progress",
    async (kind) => {
      const { time, scheduler, job, at } = fixture();
      const owner = kind === "root" ? scheduler : scheduler.scope();
      const schedule = (timing: JobTiming, run: Job["run"]) =>
        job("maintenance", timing, run, owner);
      const first = createDeferredCore();
      const second = createDeferredCore();
      const run = vi.fn();
      const firstRun = vi.fn(() => {
        void trackAsyncWork(() => first.promise);
      });
      schedule({ delayMs: 0, everyMs: 100 }, firstRun);
      const firstWake = time.wake();
      const other = job("other", { atMs: 1_100 });
      await at(1_100, [other, 1], [firstRun, 1]);
      schedule({ delayMs: 0 }, async () => {
        await second.promise;
        owner.schedule({ id: "late", delayMs: 0, run });
      });
      const secondWake = time.wake();
      job("waiting", { delayMs: 100 }, run, owner);
      const stopped = vi.fn();
      const stop = owner.stop().then(stopped);
      expect(owner.signal.aborted).toBe(true);
      expect(scheduler.nextWakeAtMs).toBeNull();
      expect(time.armedAtMs).toBeNull();
      expect(stopped).not.toHaveBeenCalled();
      second.resolve();
      await secondWake;
      expect(stopped).not.toHaveBeenCalled();
      expect(scheduler.nextWakeAtMs).toBeNull();
      first.resolve();
      await Promise.all([firstWake, stop, owner.stop()]);
      expectCalls([stopped, 1], [other, 1]);
      expect(run).not.toHaveBeenCalled();
      await scheduler.stop();
    },
  );

  it("fences scoped jobs when a due sibling closes their owner", async () => {
    const { time, scheduler } = fixture();
    const scope = scheduler.scope();
    const run = vi.fn();
    scheduler.schedule({ id: "retire-owner", delayMs: 0, run: scope.beginClose });
    scope.schedule({ id: "retired", delayMs: 0, run });
    await time.wake();
    expect(run).not.toHaveBeenCalled();
    await scope.stop();
    await scheduler.stop();
  });

  it("coalesces sleep and forward jumps into one pass while retaining absolute deadlines", async () => {
    const { scheduler, job, at } = fixture();
    const deadline = vi.fn();
    const periodic = vi.fn();
    job("approval", { atMs: 5_000 }, deadline);
    job("health", { atMs: 2_000, everyMs: 1_000 }, periodic);
    await at(301_000, [periodic, 1], [deadline, 1]);
    expect(periodic).toHaveBeenCalledBefore(deadline);
    expect(scheduler.nextWakeAtMs).toBe(302_000);
    await at(302_000, [periodic, 2]);
    await scheduler.stop();
  });

  it.each([
    { mode: undefined, atMs: 3_000, nextWakeAtMs: 3_000 },
    { mode: "earliest" as const, atMs: 3_000, nextWakeAtMs: 2_000 },
    { mode: "earliest" as const, atMs: 1_500, nextWakeAtMs: 1_500 },
  ])(
    "reschedules a pending deadline to $atMs in $mode mode",
    async ({ mode, atMs, nextWakeAtMs }) => {
      const { time, scheduler, job, at } = fixture();
      const retiredRun = vi.fn();
      const run = vi.fn();
      const retired = scheduler.schedule({ id: "queue", atMs: 2_000, run: retiredRun });
      job("queue", { atMs, mode }, run);
      retired.cancel();
      expect([scheduler.nextWakeAtMs, time.armedAtMs]).toEqual([nextWakeAtMs, nextWakeAtMs]);
      await at(nextWakeAtMs, [run, 1], [retiredRun, 0]);
      expect(scheduler.nextWakeAtMs).toBeNull();
      await scheduler.stop();
    },
  );

  it.each([
    { deadline: { delayMs: 2_000 }, clock: "elapsed" },
    { deadline: { atMs: 6_500 }, clock: "elapsed" },
    { deadline: { delayMs: 2_000 }, clock: "wall" },
  ])(
    "retains $clock eligibility after a backward wall-clock correction: $deadline",
    async ({ deadline, clock }) => {
      const { time, scheduler, job } = fixture();
      const run = vi.fn();
      time.setTime(9_000);
      job("queue", { delayMs: 1_000, mode: "earliest" }, run);
      expect(time.armedAtMs).toBe(10_000);
      time.setTime(4_000);
      await time.advanceBy(500);
      scheduler.schedule({ id: "queue", ...deadline, mode: "earliest", run });
      expect(scheduler.nextWakeAtMs).toBe(5_000);
      if (clock === "wall") {
        time.setTime(6_499);
        scheduler.schedule({ id: "other", atMs: 6_499, run: () => {} });
        await time.wake();
        expect(run).not.toHaveBeenCalled();
        expect(scheduler.nextWakeAtMs).toBe(6_500);
        await time.advanceBy(1);
      } else {
        await time.advanceTo(5_000);
      }
      expect(run).toHaveBeenCalledOnce();
      expect(scheduler.nextWakeAtMs).toBeNull();
      await scheduler.stop();
    },
  );

  it("retains an already elapsed wake when another due job refreshes its deadline", async () => {
    const { time, scheduler, job } = fixture();
    const run = vi.fn();
    time.setTime(9_000);
    job("refresh", { delayMs: 1_000 }, () => {
      job("queue", { delayMs: 2_000, mode: "earliest" }, run);
    });
    job("queue", { delayMs: 1_000, mode: "earliest" }, run);
    time.setTime(4_000);
    await time.wake();
    expect(scheduler.nextWakeAtMs).toBe(4_000);
    await time.wake();
    expect(run).toHaveBeenCalledOnce();
    expect(scheduler.nextWakeAtMs).toBeNull();
    await scheduler.stop();
  });

  it("allows a later earliest deadline after cancel, stop, or completion", async () => {
    const { scheduler, job, at } = fixture();
    const run = vi.fn();
    const cancelled = scheduler.schedule({ id: "queue", delayMs: 500, mode: "earliest", run });
    cancelled.cancel();
    const stopped = scheduler.schedule({ id: "queue", delayMs: 1_000, mode: "earliest", run });
    expect(scheduler.nextWakeAtMs).toBe(2_000);
    await stopped.stop();
    job("queue", { delayMs: 2_000, mode: "earliest" }, () => {
      run();
      job("queue", { delayMs: 1_000, mode: "earliest" }, run);
    });
    expect(scheduler.nextWakeAtMs).toBe(3_000);
    await at(3_000, [run, 1]);
    expect(scheduler.nextWakeAtMs).toBe(4_000);
    await at(4_000, [run, 2]);
    await scheduler.stop();
  });

  it("keeps cadence on a backward host wake without expiring durable deadlines early", async () => {
    const { time, scheduler, job, at } = fixture();
    const cadence = job("sample", { atMs: 2_000, everyMs: 1_000 });
    const deadline = job("lease-expiry", { atMs: 2_000 });
    time.setTime(1_500);
    await time.wake();
    expect(cadence).toHaveBeenCalledTimes(1);
    expect(deadline).not.toHaveBeenCalled();
    expect(scheduler.nextWakeAtMs).toBe(2_000);
    await at(2_000, [deadline, 1]);
    await scheduler.stop();
  });

  it("preserves elapsed cadence when new work is registered after a clock rollback", async () => {
    const { time, scheduler, job } = fixture();
    const run = job("health", { delayMs: 1_000, everyMs: 1_000 });
    await time.advanceBy(500);
    time.setTime(0);
    scheduler.schedule({ id: "new-deadline", atMs: 0, run: () => {} });
    await time.wake();
    expect(scheduler.nextWakeAtMs).toBe(500);
    await time.advanceBy(500);
    expect(run).toHaveBeenCalledOnce();
    await scheduler.stop();
  });

  it("preserves registration context and permits a deadline owner to rearm while running", async () => {
    const { time, scheduler, job } = fixture();
    const context = new AsyncLocalStorage<string>();
    const gate = createDeferredCore();
    const seen: Array<string | undefined> = [];
    context.run("cron-owner", () =>
      job("cron", { atMs: 1_000 }, async () => {
        seen.push(context.getStore());
        job("cron", { atMs: 1_100 }, () => {
          seen.push(context.getStore());
        });
        await gate.promise;
        throw new Error("run failed");
      }),
    );
    const initial = time.wake();
    await time.advanceTo(1_100);
    expect(seen).toEqual(["cron-owner", "cron-owner"]);
    gate.resolve();
    await initial;
    expect(scheduler.nextWakeAtMs).toBeNull();
    await scheduler.stop();
  });

  it("keeps request context but admits scheduled work independently after its registering turn", async () => {
    // A job outlives the turn that registered it; resuming that retired owner would
    // reject its admission with "Session turn no longer owns controller admission".
    schedulerLog.error.mockClear();
    const { time, scheduler } = fixture();
    const turn = {
      storePath: "/synthetic/scheduled-after-turn/sessions.json",
      sessionKey: "agent:main:scheduled-after-turn",
      sessionId: "scheduled-after-turn-session",
    };
    let registrant: ReplyOperation | undefined;
    const admitted: Array<ReplyOperation | undefined> = [];
    const requestContext = new AsyncLocalStorage<string>();
    const observedRequests: Array<string | undefined> = [];
    await requestContext.run("scheduled-request", () =>
      withSessionTurn(turn, async (operation) => {
        registrant = operation;
        scheduler.schedule({
          id: "after-turn",
          delayMs: 100,
          run: () =>
            withSessionTurn(turn, async (scheduled) => {
              admitted.push(scheduled);
              observedRequests.push(requestContext.getStore());
            }),
        });
      }),
    );
    expect(registrant?.result?.kind).toBe("completed");
    await time.advanceBy(100);
    await scheduler.stop();
    expect(schedulerLog.error).not.toHaveBeenCalled();
    expect(admitted).toHaveLength(1);
    expect(admitted[0]).toBeDefined();
    expect(admitted[0]).not.toBe(registrant);
    expect(observedRequests).toEqual(["scheduled-request"]);
  });

  it("retains a distant deadline across the host timer delay ceiling", async () => {
    const { scheduler, job, at } = fixture();
    const run = job("future", { atMs: 4_000_000_000 });
    await at(1_000 + 2_147_483_647, [run, 0]);
    expect(scheduler.nextWakeAtMs).toBe(4_000_000_000);
    await at(4_000_000_000, [run, 1]);
    await scheduler.stop();
  });
});
