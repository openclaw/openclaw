import { AsyncLocalStorage } from "node:async_hooks";
import { setImmediate } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import type { CronJob } from "../cron/types.js";
import { AsyncWorkScope, trackAsyncWork } from "../shared/async-work-scope.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { resolveExitWatchShell } from "./cron-exit-watch-shell.js";
import {
  createCronExitWatchers,
  type CronExitResult,
  type CronExitWatcherHandlers,
} from "./cron-exit-watchers.js";
import { makeFakeSupervisor, onExitJob } from "./cron-exit-watchers.test-support.js";

type FireOnExit = (job: CronJob, exit: CronExitResult) => Promise<void>;

const noopLogger = { info: () => {}, warn: () => {} };
let clock: ReturnType<typeof createGatewaySchedulerClock>;
let scheduler: ReturnType<typeof createTestGatewayScheduler>;

type FixtureHandlers = Omit<CronExitWatcherHandlers, "fireOnExit"> & {
  reserveExit: (job: CronJob) => Promise<void>;
  fireOnExit: FireOnExit;
  readJob?: (jobId: string) => Promise<CronJob | undefined>;
};

function createWatcherFixture(
  params: Omit<FixtureHandlers, "reserveExit" | "fireOnExit" | "logger"> &
    Partial<Pick<FixtureHandlers, "reserveExit" | "fireOnExit" | "logger">>,
) {
  const {
    reserveExit = vi.fn(async () => {}),
    fireOnExit = vi.fn(async () => {}),
    logger = noopLogger,
  } = params;
  let jobs = new Map<string, CronJob>();
  const handlers = (next: FixtureHandlers): CronExitWatcherHandlers => ({
    ...next,
    fireOnExit: async (job, exit, controls) => {
      controls.commitGuard();
      const current = next.readJob ? await next.readJob(job.id) : jobs.get(job.id);
      if (!current) {
        return;
      }
      controls.commitGuard();
      controls.onTerminalWriteStarted();
      await next.reserveExit(current);
      controls.commitGuard();
      controls.onReserved();
      await next.fireOnExit(current, exit);
    },
  });
  const watchers = createCronExitWatchers(
    handlers({ ...params, reserveExit, fireOnExit, logger }),
    scheduler,
  );
  return {
    ...watchers,
    reconcile: (current: CronJob[]) => {
      jobs = new Map(current.map((job) => [job.id, job]));
      watchers.reconcile(current);
    },
    updateHandlers: (next: FixtureHandlers) => watchers.updateHandlers(handlers(next)),
  };
}

function setup(
  params: Partial<Parameters<typeof createWatcherFixture>[0]> = {},
  options: Parameters<typeof makeFakeSupervisor>[0] = {},
) {
  const fake = makeFakeSupervisor(options);
  const reserveExit = params.reserveExit ?? vi.fn(async () => {});
  const fireOnExit = params.fireOnExit ?? vi.fn<FireOnExit>(async () => {});
  const watchers = createWatcherFixture({
    getProcessSupervisor: () => fake.supervisor as never,
    ...params,
    reserveExit,
    fireOnExit,
  });
  return { ...fake, watchers, reserveExit, fireOnExit };
}

type FakeRun = ReturnType<typeof makeFakeSupervisor>["runs"][number];
const exit = (run: FakeRun | undefined, cancelled = false) =>
  expectDefined(run, "watched command").deferred.resolve({
    exitCode: cancelled ? null : 0,
    reason: cancelled ? "manual-cancel" : "exit",
  });
const cancelRuns = (runs: FakeRun[], exitCode: number | null = null) =>
  runs.forEach((run) => run.deferred.resolve({ exitCode, reason: "manual-cancel" }));
const flush = () => setImmediate();
async function reconcile(
  watchers: Pick<ReturnType<typeof createWatcherFixture>, "reconcile">,
  jobs = [onExitJob("job-a")],
) {
  watchers.reconcile(jobs);
  await flush();
}
async function finish(run: FakeRun | undefined, cancelled = false) {
  exit(run, cancelled);
  await flush();
}

describe("createCronExitWatchers", () => {
  beforeEach(() => {
    clock = createGatewaySchedulerClock();
    scheduler = createTestGatewayScheduler(clock.clock);
  });
  afterEach(async () => {
    await scheduler.stop();
  });

  it.each(["delivery", "owner"])(
    "does not arm an exit job needing %s repair alongside a healthy sibling",
    async (repair) => {
      const { supervisor, runs, watchers } = setup();
      const invalid = onExitJob("invalid-delivery");
      if (repair === "delivery") {
        Reflect.deleteProperty(invalid.delivery!, "mode");
      } else {
        delete invalid.agentId;
      }
      try {
        await reconcile(watchers, [invalid, { ...onExitJob("healthy-exit"), agentId: "ops" }]);
        expect(supervisor.spawn).toHaveBeenCalledOnce();
        expect(watchers.activeJobIds()).toEqual(["healthy-exit"]);
      } finally {
        const settled = watchers.cancelAll();
        cancelRuns(runs, 0);
        await settled;
      }
    },
  );

  it("uses the current default when arming an ownerless exit job", async () => {
    const armed = createDeferred();
    let defaultAgentId: string | undefined = "main";
    const { supervisor, runs, watchers } = setup({
      getDefaultAgentId: () => defaultAgentId,
      logger: { ...noopLogger, info: () => armed.resolve() },
    });
    const job = onExitJob("implicit-main");
    delete job.agentId;
    try {
      defaultAgentId = undefined;
      watchers.reconcile([job]);
      expect(supervisor.spawn).not.toHaveBeenCalled();
      defaultAgentId = "main";
      watchers.reconcile([job]);
      expect(supervisor.spawn).toHaveBeenCalledOnce();
      await armed.promise;
      expect(watchers.activeJobIds()).toEqual([job.id]);
    } finally {
      const settled = watchers.cancelAll();
      cancelRuns(runs, 0);
      await settled;
    }
  });

  it("fires a historical owner's job after the creating request closes", async () => {
    const { supervisor, runs } = makeFakeSupervisor();
    const creatorContext = new AsyncLocalStorage<string>();
    const creatorWork = new AsyncWorkScope();
    const inCreator = creatorContext.run("creator", () =>
      creatorWork.run(() => AsyncLocalStorage.snapshot()),
    );
    const observedContexts: Array<string | undefined> = [];
    const spawn = expectDefined(supervisor.spawn.getMockImplementation(), "supervisor spawn");
    supervisor.spawn.mockImplementationOnce(async (input) => {
      observedContexts.push(creatorContext.getStore());
      return await spawn(input);
    });
    const order: string[] = [];
    const reserveExit = vi.fn(async () => {
      await trackAsyncWork(() => {
        observedContexts.push(creatorContext.getStore());
        order.push("persist");
      });
    });
    const fireOnExit = vi.fn(async (_job: CronJob, _exit: CronExitResult) => {
      await trackAsyncWork(() => {
        observedContexts.push(creatorContext.getStore());
        order.push("fire");
      });
    });
    const w = createWatcherFixture({
      getDefaultAgentId: () => "research",
      getProcessSupervisor: () => supervisor as never,
      reserveExit,
      fireOnExit,
    });

    inCreator(() => w.reconcile([{ ...onExitJob("job-a"), agentId: "ops" }]));
    await creatorWork.drain();
    await flush();
    expect(supervisor.spawn).toHaveBeenCalledTimes(1);
    expect(w.activeJobIds()).toEqual(["job-a"]);
    expect(fireOnExit).not.toHaveBeenCalled();

    await finish(runs[0]);
    expect(fireOnExit).toHaveBeenCalledTimes(1);
    expect(fireOnExit).toHaveBeenCalledWith(
      expect.objectContaining({ id: "job-a", agentId: "ops" }),
      expect.objectContaining({ exitCode: 0, reason: "exit", stdout: "", stderr: "" }),
    );

    expect(reserveExit).toHaveBeenCalledWith(expect.objectContaining({ id: "job-a" }));
    expect(order).toEqual(["persist", "fire"]);
    expect(observedContexts).toEqual([undefined, undefined, undefined]);
    await expect(inCreator(() => trackAsyncWork(() => undefined))).rejects.toThrow(
      "Async work scope is closed",
    );
  });

  it("rebinds live watchers but drains callbacks already owned by the previous scheduler", async () => {
    const { promise: persistenceGate, resolve: releasePersistence } = createDeferred();
    const oldReserveExit = vi.fn(async () => {
      await persistenceGate;
    });
    const oldFireOnExit = vi.fn(async () => {});
    const newReserveExit = vi.fn(async () => {});
    const newFireOnExit = vi.fn(async () => {});
    const { supervisor, runs, watchers } = setup({
      reserveExit: oldReserveExit,
      fireOnExit: oldFireOnExit,
    });

    await reconcile(watchers, [onExitJob("old-owner"), onExitJob("new-owner")]);
    exit(runs[0]);
    await vi.waitFor(() => expect(oldReserveExit).toHaveBeenCalledOnce());

    const handoff = watchers.updateHandlers({
      getProcessSupervisor: () => supervisor as never,
      reserveExit: newReserveExit,
      fireOnExit: newFireOnExit,
      logger: noopLogger,
    });
    const handoffSettled = vi.fn();
    void handoff?.then(handoffSettled);

    exit(runs[1]);
    await vi.waitFor(() => expect(newFireOnExit).toHaveBeenCalledOnce());
    expect(newReserveExit).toHaveBeenCalledOnce();
    expect(oldFireOnExit).not.toHaveBeenCalled();
    expect(handoffSettled).not.toHaveBeenCalled();

    releasePersistence();
    await handoff;
    await vi.waitFor(() => expect(oldFireOnExit).toHaveBeenCalledOnce());
    expect(supervisor.spawn).toHaveBeenCalledTimes(2);
    expect(supervisor.cancelScope).not.toHaveBeenCalled();
  });

  it("rebinds a pending callback during scheduler handoff", async () => {
    const { supervisor, runs } = makeFakeSupervisor();
    const oldWaitAborted = vi.fn();
    const waiting = createDeferred();
    const watchers = createCronExitWatchers(
      {
        getProcessSupervisor: () => supervisor as never,
        logger: noopLogger,
        fireOnExit: async (_job, _exit, { signal }) => {
          await new Promise<void>((resolve) => {
            signal.addEventListener(
              "abort",
              () => {
                oldWaitAborted();
                resolve();
              },
              { once: true },
            );
            waiting.resolve();
          });
        },
      },
      scheduler,
    );
    await reconcile(watchers);
    exit(runs[0]);
    await waiting.promise;
    const newFire = vi.fn(async () => {});
    const newPersist = vi.fn(async () => {});
    await watchers.updateHandlers({
      getProcessSupervisor: () => supervisor as never,
      fireOnExit: async (_job, _exit, controls) => {
        controls.commitGuard();
        controls.onTerminalWriteStarted();
        await newPersist();
        controls.onReserved();
        await newFire();
      },
      logger: noopLogger,
    });
    await vi.waitFor(() => expect(newFire).toHaveBeenCalledOnce());
    expect(newPersist).toHaveBeenCalledOnce();
    expect(oldWaitAborted).toHaveBeenCalledOnce();
    expect(supervisor.spawn).toHaveBeenCalledOnce();
    await watchers.cancelAll();
  });

  it.each(["rearm", "disable", "replace"] as const)(
    "preserves reserved admission only across harmless rearm (%s)",
    async (action) => {
      const { supervisor, runs } = makeFakeSupervisor();
      const reserved = createDeferred();
      const release = createDeferred();
      const settled = createDeferred();
      const fired = vi.fn();
      let job = onExitJob("job-a");
      const watchers = createCronExitWatchers(
        {
          getProcessSupervisor: () => supervisor as never,
          logger: noopLogger,
          fireOnExit: async (_job, _exit, controls) => {
            try {
              controls.commitGuard();
              job = { ...job, enabled: false };
              controls.onReserved();
              reserved.resolve();
              await release.promise;
              controls.commitGuard();
              fired();
            } finally {
              settled.resolve();
            }
          },
        },
        scheduler,
      );
      try {
        await reconcile(watchers, [job]);
        exit(runs[0]);
        await reserved.promise;
        job = { ...job, enabled: true };
        await reconcile(watchers, [job]);
        expect(supervisor.spawn).toHaveBeenCalledTimes(2);
        if (action === "disable") {
          job = { ...job, enabled: false };
          watchers.reconcile([job]);
        } else if (action === "replace") {
          job = { ...job, schedule: { kind: "on-exit", command: "replacement" } };
          await reconcile(watchers, [job]);
        }
        release.resolve();
        await settled.promise;
        expect(fired).toHaveBeenCalledTimes(action === "rearm" ? 1 : 0);
      } finally {
        release.resolve();
        cancelRuns(runs);
        await watchers.cancelAll();
      }
    },
  );

  it("retains a pending retry across handler handoff and uses the replacement owner", async () => {
    const oldUpdateWatcherState = vi.fn(async () => {});
    const newUpdateWatcherState = vi.fn(async () => {});
    const { supervisor, runs, watchers, reserveExit, fireOnExit } = setup({
      updateWatcherState: oldUpdateWatcherState,
    });

    await reconcile(watchers);
    expectDefined(runs[0], "first watcher").deferred.reject(new Error("wait failed"));
    await flush();
    expect(oldUpdateWatcherState).toHaveBeenCalledOnce();
    expect(oldUpdateWatcherState).toHaveBeenCalledWith(
      expect.objectContaining({ id: "job-a" }),
      expect.objectContaining({ consecutiveErrors: 1 }),
    );
    expect(reserveExit).not.toHaveBeenCalled();
    expect(fireOnExit).not.toHaveBeenCalled();
    expect(watchers.activeJobIds()).toEqual(["job-a"]);
    expect(scheduler.nextWakeAtMs).toBe(1_000);
    await watchers.updateHandlers({
      getProcessSupervisor: () => supervisor as never,
      reserveExit: vi.fn(async () => {}),
      fireOnExit: vi.fn(async () => {}),
      updateWatcherState: newUpdateWatcherState,
      logger: noopLogger,
    });
    await clock.advanceBy(1_000);
    expect(supervisor.spawn).toHaveBeenCalledTimes(2);
    expect(watchers.activeJobIds()).toEqual(["job-a"]);
    expectDefined(runs[1], "replacement watcher").deferred.reject(new Error("replacement failed"));
    await flush();
    expect(newUpdateWatcherState).toHaveBeenCalledOnce();
    expect(oldUpdateWatcherState).toHaveBeenCalledOnce();
    await watchers.cancelAll();
    await clock.advanceBy(5_000);
    expect(supervisor.spawn).toHaveBeenCalledTimes(2);
  });

  it("joins a scheduled retry's failed-start publication during scheduler shutdown", async () => {
    const firstRetryScheduled = createDeferred();
    const retryFailure = createDeferred();
    const releaseRetry = createDeferred();
    const { supervisor, watchers } = setup({
      updateWatcherState: vi.fn(async (_job, patch) => {
        if (patch.consecutiveErrors !== 1) {
          retryFailure.resolve();
          await releaseRetry.promise;
        }
      }),
      logger: { ...noopLogger, warn: () => firstRetryScheduled.resolve() },
    });
    supervisor.spawn.mockRejectedValue(new Error("spawn failed"));
    watchers.reconcile([onExitJob("job-a")]);
    await firstRetryScheduled.promise;
    expect(scheduler.nextWakeAtMs).toBe(1_000);
    const retry = clock.advanceBy(1_000);
    await retryFailure.promise;
    let stopped = false;
    const stopping = scheduler.stop().then(() => {
      stopped = true;
    });
    try {
      for (let turn = 0; turn < 5; turn += 1) {
        await Promise.resolve();
      }
      expect(stopped).toBe(false);
    } finally {
      releaseRetry.resolve();
      await retry;
      await stopping;
      await watchers.cancelAll();
    }
    expect(supervisor.spawn).toHaveBeenCalledTimes(2);
    expect(scheduler.nextWakeAtMs).toBeNull();
    expect(watchers.activeJobIds()).toEqual([]);
  });

  it("restarts retries while a cancelled retry's publication is still settling", async ({
    signal,
  }) => {
    const firstRetryScheduled = createDeferred();
    const retryFailure = createDeferred();
    const releaseRetry = createDeferred();
    const replacementRetryScheduled = createDeferred();
    let restarting = false;
    const { supervisor, runs, watchers, fireOnExit } = setup({
      updateWatcherState: async (job, patch) => {
        if (job.id === "job-a" && patch.consecutiveErrors === 2) {
          retryFailure.resolve();
          await releaseRetry.promise;
        }
      },
      logger: {
        ...noopLogger,
        warn: () => (restarting ? replacementRetryScheduled : firstRetryScheduled).resolve(),
      },
    });
    supervisor.spawn
      .mockRejectedValueOnce(new Error("initial spawn failed"))
      .mockRejectedValueOnce(new Error("retry spawn failed"))
      .mockRejectedValueOnce(new Error("replacement spawn failed"));
    let retry: Promise<void> | undefined;
    let cancelling: Promise<void> | undefined;
    try {
      watchers.reconcile([onExitJob("job-a")]);
      await withinTest(firstRetryScheduled.promise, signal);
      retry = Promise.resolve(clock.advanceBy(1_000));
      await withinTest(retryFailure.promise, signal);
      cancelling = watchers.cancelAll();
      expect(scheduler.nextWakeAtMs).toBeNull();

      restarting = true;
      watchers.reconcile([onExitJob("job-b")]);
      await withinTest(
        awaitGateBeforeSettlement(
          replacementRetryScheduled.promise,
          cancelling,
          "Watcher cancellation completed before its failure publication settled",
        ),
        signal,
      );
      expect(scheduler.nextWakeAtMs).toBe(2_000);
      releaseRetry.resolve();
      await withinTest(Promise.all([retry, cancelling]), signal);
      expect(watchers.activeJobIds()).toEqual(["job-b"]);
      expect(scheduler.nextWakeAtMs).toBe(2_000);

      await withinTest(Promise.resolve(clock.advanceBy(1_000)), signal);
      expect(supervisor.spawn).toHaveBeenCalledTimes(4);
      expect(runs).toHaveLength(1);
      expect(watchers.activeJobIds()).toEqual(["job-b"]);
      expect(fireOnExit).not.toHaveBeenCalled();
    } finally {
      releaseRetry.resolve();
      const closing = watchers.cancelAll();
      cancelRuns(runs);
      await Promise.all([retry, cancelling, closing]);
    }
  });

  it("does NOT fire when reserveExit fails (fail closed to avoid replay)", async () => {
    const {
      supervisor,
      runs,
      fireOnExit,
      watchers: w,
    } = setup({
      reserveExit: vi.fn(async () => {
        throw new Error("store write failed");
      }),
    });
    await reconcile(w);
    await finish(runs[0]);
    expect(fireOnExit).not.toHaveBeenCalled();
    expect(w.activeJobIds()).toEqual([]);
    await reconcile(w);
    expect(supervisor.spawn).toHaveBeenCalledTimes(2);
    expect(w.activeJobIds()).toEqual(["job-a"]);
  });

  it("cancels and kills an in-flight spawn when the job is removed mid-spawn", async () => {
    const { fireOnExit, watchers: w, ...fake } = setup({}, { deferSpawn: true });
    await reconcile(w);
    w.reconcile([]);
    fake.releaseSpawn();
    await flush();
    await flush();

    expect(fake.runCancels.length).toBe(1);
    expect(fireOnExit).not.toHaveBeenCalled();
    expect(w.activeJobIds()).toEqual(["job-a"]);
    exit(fake.runs[0], true);
    await vi.waitFor(() => expect(w.activeJobIds()).toEqual([]));
  });

  it("keeps a cancelled watcher blocking through result settlement until cleanup finishes", async () => {
    const cleanup = createDeferred();
    const { cancelled, runs, watchers: w } = setup({}, { cleanup: () => cleanup.promise });
    await reconcile(w);
    const drained = vi.fn();
    const drain = w.cancelAll().then(drained);
    expect(cancelled).toContain("cron-exit:job-a");
    expect(w.activeJobIds()).toEqual(["job-a"]);
    await flush();
    expect(drained).not.toHaveBeenCalled();

    await finish(runs[0], true);
    expect(drained).not.toHaveBeenCalled();
    expect(w.activeJobIds()).toEqual(["job-a"]);
    cleanup.resolve(undefined);
    await drain;
    expect(w.activeJobIds()).toEqual([]);
  });

  it.for(["exit", "wait-failure", "late-spawn"] as const)(
    "retains cleanup failure without firing, retrying, or rearming after %s",
    async (phase, { signal }) => {
      const cleanup = createDeferred();
      void cleanup.promise.catch(() => {});
      const cleanupFailed = createDeferred();
      const updateWatcherState = vi.fn(async () => {});
      const { watchers, fireOnExit, reserveExit, ...fake } = setup(
        { updateWatcherState, logger: { ...noopLogger, warn: () => cleanupFailed.resolve() } },
        { deferSpawn: phase === "late-spawn", cleanup: () => cleanup.promise },
      );
      const job = onExitJob("job-a");
      const error = new Error("cleanup could not be confirmed");
      try {
        await reconcile(watchers, [job]);
        if (phase === "late-spawn") {
          watchers.reconcile([]);
          fake.releaseSpawn();
          await flush();
          expect(fake.runCancels).toHaveLength(1);
        }
        const run = expectDefined(fake.runs[0], "watched run");
        if (phase === "wait-failure") {
          run.deferred.reject(new Error("result unavailable"));
        } else {
          run.deferred.resolve({
            exitCode: phase === "late-spawn" ? null : 0,
            reason: phase === "late-spawn" ? "manual-cancel" : "exit",
          });
        }
        cleanup.reject(error);
        await withinTest(cleanupFailed.promise, signal);
        await expect(watchers.cancelAll()).rejects.toBe(error);
        await reconcile(watchers, [
          { ...job, schedule: { kind: "on-exit", command: "replacement" } },
        ]);
        expect(watchers.activeJobIds()).toEqual([job.id]);
        expect(fake.supervisor.spawn).toHaveBeenCalledOnce();
        expect(fireOnExit).not.toHaveBeenCalled();
        expect(reserveExit).not.toHaveBeenCalled();
        expect(updateWatcherState).not.toHaveBeenCalled();
        expect(scheduler.nextWakeAtMs).toBeNull();
        await expect(watchers.cancelAll()).rejects.toBe(error);
      } finally {
        fake.releaseSpawn();
        cleanup.resolve(undefined);
        cancelRuns(fake.runs);
        await Promise.allSettled([watchers.cancelAll()]);
      }
    },
  );

  it("waits for cancelled command cleanup before launching its replacement", async ({ signal }) => {
    const cleanup = createDeferred();
    const cleanupJoined = createDeferred();
    const fired = createDeferred();
    const { supervisor, runs, watchers, fireOnExit } = setup(
      { fireOnExit: vi.fn(async () => fired.resolve()) },
      {
        cleanup: () => {
          cleanupJoined.resolve();
          return cleanup.promise;
        },
      },
    );
    try {
      await reconcile(watchers);
      watchers.reconcile([onExitJob("job-a", "replacement")]);
      await withinTest(cleanupJoined.promise, signal);
      expect(supervisor.spawn).toHaveBeenCalledOnce();
      await finish(runs[0], true);
      expect(supervisor.spawn).toHaveBeenCalledOnce();
      expect(watchers.activeJobIds()).toEqual(["job-a"]);
      cleanup.resolve(undefined);
      await flush();
      expect(supervisor.spawn).toHaveBeenCalledTimes(2);
      exit(runs[1]);
      await withinTest(fired.promise, signal);
      expect(fireOnExit).toHaveBeenCalledOnce();
    } finally {
      cleanup.resolve(undefined);
      cancelRuns(runs);
      await watchers.cancelAll();
    }
  });

  it.for(["confirmed", "failed"] as const)(
    "joins rejected-startup cleanup before retry or cancellation (%s)",
    async (outcome, { signal }) => {
      const cleanup = createDeferred();
      const cleanupEntered = createDeferred();
      const published = createDeferred();
      const startError = new Error("command startup failed");
      const cleanupError = new Error("native cleanup identity lost");
      const { watchers, fireOnExit, ...fake } = setup(
        { logger: { ...noopLogger, warn: () => published.resolve() } },
        {
          cleanup: () => {
            cleanupEntered.resolve();
            return cleanup.promise;
          },
        },
      );
      fake.supervisor.spawn.mockRejectedValueOnce(startError);
      try {
        watchers.reconcile([onExitJob("job-a")]);
        await withinTest(cleanupEntered.promise, signal);
        expect(fake.supervisor.acquireScopeCleanup).toHaveBeenCalledWith("cron-exit:job-a", {
          processTree: "required-all",
        });
        expect(fake.supervisor.acquireScopeCleanup.mock.invocationCallOrder[0]).toBeLessThan(
          expectDefined(fake.supervisor.spawn.mock.invocationCallOrder[0], "native spawn order"),
        );
        expect(scheduler.nextWakeAtMs).toBeNull();
        expect(watchers.activeJobIds()).toEqual(["job-a"]);
        if (outcome === "confirmed") {
          cleanup.resolve();
          await withinTest(published.promise, signal);
          expect(scheduler.nextWakeAtMs).toBe(1_000);
          await withinTest(Promise.resolve(clock.advanceBy(1_000)), signal);
          expect(fake.supervisor.spawn).toHaveBeenCalledTimes(2);
          expect(fake.supervisor.acquireScopeCleanup).toHaveBeenCalledTimes(2);
        } else {
          let drained = false;
          const cancellation = watchers.cancelAll().then(
            () => {
              drained = true;
            },
            (error: unknown) => {
              drained = true;
              return error;
            },
          );
          await flush();
          expect(drained).toBe(false);
          cleanup.reject(cleanupError);
          expect(await withinTest(cancellation, signal)).toBe(cleanupError);
          expect(watchers.activeJobIds()).toEqual(["job-a"]);
          await reconcile(watchers, [onExitJob("job-a", "replacement")]);
          expect(fake.supervisor.spawn).toHaveBeenCalledOnce();
          expect(scheduler.nextWakeAtMs).toBeNull();
          await expect(watchers.cancelAll()).rejects.toBe(cleanupError);
        }
        expect(fireOnExit).not.toHaveBeenCalled();
      } finally {
        cleanup.resolve();
        const cancellation = watchers.cancelAll();
        cancelRuns(fake.runs);
        await Promise.allSettled([cancellation]);
      }
    },
  );

  it("retains a blocker and suppresses stale fire when removed during terminal persistence", async () => {
    const persistence = createDeferred();
    const reserveExit = vi.fn(() => persistence.promise);
    const { runs, fireOnExit, watchers: w } = setup({ reserveExit });
    await reconcile(w);

    exit(runs[0]);
    await vi.waitFor(() => expect(reserveExit).toHaveBeenCalledOnce());
    const drained = vi.fn();
    const drain = w.cancelAll().then(drained);
    expect(w.activeJobIds()).toEqual(["job-a"]);
    await flush();
    expect(drained).not.toHaveBeenCalled();

    persistence.resolve();
    await drain;
    expect(w.activeJobIds()).toEqual([]);
    expect(fireOnExit).not.toHaveBeenCalled();
  });

  it.each(["true", "echo rearmed"])(
    "re-arms %s while the previous payload settles and drains both owners",
    async (command) => {
      const { supervisor, runs } = makeFakeSupervisor({
        cleanup: async () => undefined,
      });
      const payload = createDeferred();
      let job = onExitJob("job-a");
      const fireOnExit = vi.fn(async () => await payload.promise);
      const reserveExit = vi.fn(async () => {
        job = { ...job, enabled: false };
      });
      const w = createWatcherFixture({
        getProcessSupervisor: () => supervisor as never,
        reserveExit,
        fireOnExit,
      });

      try {
        await reconcile(w, [job]);
        exit(runs[0]);
        await vi.waitFor(() => expect(fireOnExit).toHaveBeenCalledOnce());
        w.reconcile([job]);
        expect(supervisor.spawn).toHaveBeenCalledOnce();

        job = { ...job, enabled: true, schedule: { kind: "on-exit", command } };
        await reconcile(w, [job]);
        expect(supervisor.spawn).toHaveBeenCalledTimes(2);
        expect(w.activeJobIds()).toEqual([job.id]);
        await finish(runs[1]);
        expect(reserveExit).toHaveBeenCalledOnce();

        const drained = vi.fn();
        const drain = w.cancelAll().then(drained);
        await flush();
        expect(drained).not.toHaveBeenCalled();
        payload.resolve();
        await drain;
        expect(w.activeJobIds()).toEqual([]);
        expect(fireOnExit).toHaveBeenCalledOnce();
      } finally {
        payload.resolve();
        cancelRuns(runs);
        await w.cancelAll();
      }
    },
  );

  it.each([false, true])(
    "keeps only the latest pending exit after another rearm (read failure: %s)",
    async (failRead) => {
      const { supervisor, runs } = makeFakeSupervisor();
      const payload = createDeferred();
      let job = onExitJob("job-a");
      const readJob = vi.fn(async () => {
        if (failRead && job.schedule.kind === "on-exit" && job.schedule.command === "third") {
          throw new Error("store read failed");
        }
        return job;
      });
      const reserveExit = vi.fn(async () => {
        job = { ...job, enabled: false };
      });
      const fireOnExit = vi.fn<FireOnExit>(async () => await payload.promise);
      const warn = vi.fn();
      const watchers = createWatcherFixture({
        getProcessSupervisor: () => supervisor as never,
        readJob,
        reserveExit,
        fireOnExit,
        logger: { ...noopLogger, warn },
      });

      try {
        await reconcile(watchers, [job]);
        exit(runs[0]);
        await vi.waitFor(() => expect(fireOnExit).toHaveBeenCalledOnce());

        for (const command of ["second", "third"]) {
          job = { ...job, enabled: true, schedule: { kind: "on-exit", command } };
          await reconcile(watchers, [job]);
          await finish(runs.at(-1));
        }
        expect(reserveExit).toHaveBeenCalledOnce();
        expect(fireOnExit).toHaveBeenCalledOnce();
        payload.resolve();

        if (failRead) {
          await vi.waitFor(() => expect(warn).toHaveBeenCalledOnce());
          expect(warn).toHaveBeenCalledWith(
            expect.objectContaining({ err: "Error: store read failed", jobId: job.id }),
            "cron-exit: fireOnExit after exit failed",
          );
          expect(fireOnExit).toHaveBeenCalledOnce();
          expect(watchers.activeJobIds()).toEqual([]);
        } else {
          await vi.waitFor(() => expect(fireOnExit).toHaveBeenCalledTimes(2));
          expect(fireOnExit.mock.calls[1]?.[0].schedule).toEqual({
            kind: "on-exit",
            command: "third",
          });
          expect(reserveExit).toHaveBeenCalledTimes(2);
        }
        expect(readJob).toHaveBeenCalledTimes(2);
        expect(supervisor.spawn).toHaveBeenCalledTimes(3);
      } finally {
        payload.resolve();
        cancelRuns(runs);
        await watchers.cancelAll();
      }
    },
  );
});

describe("resolveExitWatchShell", () => {
  it("uses cmd.exe on Windows so native gateways without bash can run on-exit", () => {
    const shell = resolveExitWatchShell("win32");
    expect(shell.command).toMatch(/cmd\.exe$/i);
    expect(shell.argsFor("echo hi")).toEqual(["/d", "/s", "/c", "echo hi"]);
  });

  it("uses bash -lc on POSIX", () => {
    expect(resolveExitWatchShell("linux").command).toBe("bash");
    expect(resolveExitWatchShell("linux").argsFor("echo hi")).toEqual(["-lc", "echo hi"]);
    expect(resolveExitWatchShell("darwin").command).toBe("bash");
  });
});
