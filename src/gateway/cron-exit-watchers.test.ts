import { setImmediate, setTimeout as delay } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { CronJob } from "../cron/types.js";
import { resolveExitWatchShell } from "./cron-exit-watch-shell.js";
import {
  createCronExitWatchers,
  type CronExitResult,
  type CronExitWatcherHandlers,
} from "./cron-exit-watchers.js";

type Deferred = {
  resolve: (exit: { exitCode: number | null; reason: string }) => void;
  reject: (err: unknown) => void;
};

type FireOnExit = (job: CronJob, exit: CronExitResult) => Promise<void>;

/**
 * Minimal fake ProcessSupervisor: each spawn returns a run whose wait() is
 * controlled by the test, so we can deterministically drive "command exited".
 */
function makeFakeSupervisor(opts: { deferSpawn?: boolean } = {}) {
  const runs: { scopeKey?: string; runId: string; deferred: Deferred; cancelled: boolean }[] = [];
  const cancelledScopes: string[] = [];
  const runCancels: string[] = [];
  let counter = 0;
  let releaseSpawn: (() => void) | undefined;
  const spawnGate = opts.deferSpawn
    ? new Promise<void>((res) => {
        releaseSpawn = res;
      })
    : Promise.resolve();
  const supervisor = {
    spawn: vi.fn(async (input: { scopeKey?: string }) => {
      await spawnGate;
      counter += 1;
      const runId = `run-${counter}`;
      const {
        promise: waitPromise,
        resolve: resolveWait,
        reject: rejectWait,
      } = createDeferred<{ exitCode: number | null; reason: string }>();
      // Pre-attach a no-op catch so a test-driven rejection never escapes as an
      // unhandled rejection if the run loses ownership before it awaits wait().
      waitPromise.catch(() => {});
      const entry = {
        scopeKey: input.scopeKey,
        runId,
        deferred: { resolve: resolveWait, reject: rejectWait },
        cancelled: false,
      };
      runs.push(entry);
      return {
        runId,
        startedAtMs: 0,
        wait: () =>
          waitPromise.then((e) => ({
            ...e,
            exitSignal: null,
            durationMs: 1,
            stdout: "",
            stderr: "",
            timedOut: false,
            noOutputTimedOut: false,
          })),
        cancel: () => {
          entry.cancelled = true;
          runCancels.push(runId);
        },
      };
    }),
    cancelScope: vi.fn((scopeKey: string) => {
      cancelledScopes.push(scopeKey);
    }),
  };
  return {
    supervisor,
    runs,
    cancelled: cancelledScopes,
    cancelledScopes,
    runCancels,
    releaseSpawn: () => releaseSpawn?.(),
  };
}

function onExitJob(id: string, command = "true", enabled = true): CronJob {
  return {
    id,
    name: id,
    enabled,
    createdAtMs: 1,
    updatedAtMs: 1,
    schedule: { kind: "on-exit", command },
    sessionTarget: "main",
    wakeMode: "now",
    payload: { kind: "systemEvent", text: "done" },
    delivery: { mode: "none" },
    state: {},
  } as unknown as CronJob;
}

const noopLogger = { info: () => {}, warn: () => {} };

type FixtureHandlers = Omit<CronExitWatcherHandlers, "fireOnExit"> & {
  reserveExit: (job: CronJob) => Promise<void>;
  fireOnExit: FireOnExit;
  readJob?: (jobId: string) => Promise<CronJob | undefined>;
  waitForRunSettlement?: (jobId: string, signal: AbortSignal) => Promise<boolean>;
};

function createWatcherFixture(
  params: FixtureHandlers &
    Pick<Parameters<typeof createCronExitWatchers>[0], "shell" | "retryBackoffMs">,
) {
  let jobs = new Map<string, CronJob>();
  const handlers = (next: FixtureHandlers): CronExitWatcherHandlers => ({
    ...next,
    fireOnExit: async (job, exit, controls) => {
      if (
        next.waitForRunSettlement &&
        !(await next.waitForRunSettlement(job.id, controls.signal))
      ) {
        return;
      }
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
  const watchers = createCronExitWatchers({ ...params, ...handlers(params) });
  return {
    ...watchers,
    reconcile: (current: CronJob[]) => {
      jobs = new Map(current.map((job) => [job.id, job]));
      watchers.reconcile(current);
    },
    updateHandlers: (next: FixtureHandlers) => watchers.updateHandlers(handlers(next)),
  };
}

const flush = () => setImmediate();

describe("createCronExitWatchers", () => {
  it("arms a watcher for an enabled on-exit job and fires the job on exit", async () => {
    const { supervisor, runs } = makeFakeSupervisor();
    const order: string[] = [];
    const reserveExit = vi.fn(async () => {
      order.push("persist");
    });
    const fireOnExit = vi.fn(async (_job: CronJob, _exit: CronExitResult) => {
      order.push("fire");
    });
    const w = createWatcherFixture({
      getProcessSupervisor: () => supervisor as never,
      reserveExit,
      fireOnExit,
      logger: noopLogger,
    });

    w.reconcile([onExitJob("job-a")]);
    await flush();
    expect(supervisor.spawn).toHaveBeenCalledTimes(1);
    expect(w.activeJobIds()).toEqual(["job-a"]);
    expect(fireOnExit).not.toHaveBeenCalled();

    // Watched command exits → job fires through the run pipeline.
    expectDefined(runs[0], "runs[0] test invariant").deferred.resolve({
      exitCode: 0,
      reason: "exit",
    });
    await flush();
    expect(fireOnExit).toHaveBeenCalledTimes(1);
    expect(fireOnExit.mock.calls[0]?.[0].id).toBe("job-a");
    expect(fireOnExit.mock.calls[0]?.[1]).toMatchObject({
      exitCode: 0,
      reason: "exit",
      stdout: "",
      stderr: "",
    });
    // One-shot terminal state is persisted BEFORE firing (restart-safe).
    expect(reserveExit).toHaveBeenCalledWith(expect.objectContaining({ id: "job-a" }));
    expect(order).toEqual(["persist", "fire"]);
  });

  it("rebinds live watchers but drains callbacks already owned by the previous scheduler", async () => {
    const { supervisor, runs } = makeFakeSupervisor();
    const { promise: persistenceGate, resolve: releasePersistence } = createDeferred();
    const oldReserveExit = vi.fn(async () => {
      await persistenceGate;
    });
    const oldFireOnExit = vi.fn(async () => {});
    const newReserveExit = vi.fn(async () => {});
    const newFireOnExit = vi.fn(async () => {});
    const watchers = createWatcherFixture({
      getProcessSupervisor: () => supervisor as never,
      reserveExit: oldReserveExit,
      fireOnExit: oldFireOnExit,
      logger: noopLogger,
    });

    watchers.reconcile([onExitJob("old-owner"), onExitJob("new-owner")]);
    await flush();
    expectDefined(runs[0], "runs[0] test invariant").deferred.resolve({
      exitCode: 0,
      reason: "exit",
    });
    await vi.waitFor(() => expect(oldReserveExit).toHaveBeenCalledOnce());

    const handoff = watchers.updateHandlers({
      getProcessSupervisor: () => supervisor as never,
      reserveExit: newReserveExit,
      fireOnExit: newFireOnExit,
      logger: noopLogger,
    });
    const handoffSettled = vi.fn();
    void handoff?.then(handoffSettled);

    expectDefined(runs[1], "runs[1] test invariant").deferred.resolve({
      exitCode: 0,
      reason: "exit",
    });
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

  it("rebinds a pending receipt wait during scheduler handoff", async () => {
    const { supervisor, runs } = makeFakeSupervisor();
    const oldWaitAborted = vi.fn();
    const oldPersist = vi.fn(async () => {});
    const oldFire = vi.fn(async () => {});
    const oldWait = vi.fn(
      async (_jobId: string, signal: AbortSignal) =>
        await new Promise<boolean>((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              oldWaitAborted();
              resolve(false);
            },
            { once: true },
          );
        }),
    );
    const watchers = createWatcherFixture({
      getProcessSupervisor: () => supervisor as never,
      waitForRunSettlement: oldWait,
      reserveExit: oldPersist,
      fireOnExit: oldFire,
      logger: noopLogger,
    });
    watchers.reconcile([onExitJob("job-a")]);
    await flush();
    expectDefined(runs[0], "watched command").deferred.resolve({ exitCode: 0, reason: "exit" });
    await vi.waitFor(() => expect(oldWait).toHaveBeenCalledOnce());
    const newFire = vi.fn(async () => {});
    const newPersist = vi.fn(async () => {});
    await watchers.updateHandlers({
      getProcessSupervisor: () => supervisor as never,
      reserveExit: newPersist,
      fireOnExit: newFire,
      logger: noopLogger,
    });
    await vi.waitFor(() => expect(newFire).toHaveBeenCalledOnce());
    expect(newPersist).toHaveBeenCalledOnce();
    expect(oldWaitAborted).toHaveBeenCalledOnce();
    expect(oldPersist).not.toHaveBeenCalled();
    expect(oldFire).not.toHaveBeenCalled();
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
      const watchers = createCronExitWatchers({
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
      });
      try {
        watchers.reconcile([job]);
        await flush();
        expectDefined(runs[0], "first watcher").deferred.resolve({ exitCode: 0, reason: "exit" });
        await reserved.promise;
        job = { ...job, enabled: true };
        watchers.reconcile([job]);
        await flush();
        expect(supervisor.spawn).toHaveBeenCalledTimes(2);
        if (action === "disable") {
          job = { ...job, enabled: false };
          watchers.reconcile([job]);
        } else if (action === "replace") {
          job = { ...job, schedule: { kind: "on-exit", command: "replacement" } };
          watchers.reconcile([job]);
          await flush();
        }
        release.resolve();
        await settled.promise;
        expect(fired).toHaveBeenCalledTimes(action === "rearm" ? 1 : 0);
      } finally {
        release.resolve();
        for (const run of runs) {
          run.deferred.resolve({ exitCode: null, reason: "manual-cancel" });
        }
        await watchers.cancelAll();
      }
    },
  );

  it("routes post-handoff retries through the replacement scheduler owner", async () => {
    const { supervisor, runs } = makeFakeSupervisor();
    const oldUpdateWatcherState = vi.fn(async () => {});
    const newUpdateWatcherState = vi.fn(async () => {});
    const watchers = createWatcherFixture({
      getProcessSupervisor: () => supervisor as never,
      reserveExit: vi.fn(async () => {}),
      fireOnExit: vi.fn(async () => {}),
      updateWatcherState: oldUpdateWatcherState,
      logger: noopLogger,
      retryBackoffMs: [0],
    });

    watchers.reconcile([onExitJob("job-a")]);
    await flush();
    await watchers.updateHandlers({
      getProcessSupervisor: () => supervisor as never,
      reserveExit: vi.fn(async () => {}),
      fireOnExit: vi.fn(async () => {}),
      updateWatcherState: newUpdateWatcherState,
      logger: noopLogger,
    });
    expectDefined(runs[0], "runs[0] test invariant").deferred.reject(new Error("wait failed"));

    await vi.waitFor(() => expect(newUpdateWatcherState).toHaveBeenCalledOnce());
    expect(oldUpdateWatcherState).not.toHaveBeenCalled();
    await delay(5);
    await flush();
    expect(supervisor.spawn).toHaveBeenCalledTimes(2);
  });

  it("a fired job stays unarmed across a simulated restart (disabled in store → not re-run)", async () => {
    // reserveExit disables the job; after a restart the reconcile sees a
    // disabled job and must NOT re-arm (which would re-run the command).
    const { supervisor, runs } = makeFakeSupervisor();
    const w = createWatcherFixture({
      getProcessSupervisor: () => supervisor as never,
      reserveExit: vi.fn(async () => {}),
      fireOnExit: vi.fn(async () => {}),
      logger: noopLogger,
    });
    w.reconcile([onExitJob("job-a")]);
    await flush();
    expectDefined(runs[0], "runs[0] test invariant").deferred.resolve({
      exitCode: 0,
      reason: "exit",
    });
    await flush();
    expect(supervisor.spawn).toHaveBeenCalledTimes(1);
    // Simulate restart: a fresh manager reconciling the now-disabled persisted job.
    const restarted = createWatcherFixture({
      getProcessSupervisor: () => supervisor as never,
      reserveExit: vi.fn(async () => {}),
      fireOnExit: vi.fn(async () => {}),
      logger: noopLogger,
    });
    restarted.reconcile([onExitJob("job-a", "sleep 1", false)]); // enabled=false after completion
    await flush();
    expect(supervisor.spawn).toHaveBeenCalledTimes(1); // no re-spawn → command not re-run
    expect(restarted.activeJobIds()).toEqual([]);
  });

  it("does NOT fire when reserveExit fails (fail closed to avoid replay)", async () => {
    const { supervisor, runs } = makeFakeSupervisor();
    const fireOnExit = vi.fn(async () => {});
    const w = createWatcherFixture({
      getProcessSupervisor: () => supervisor as never,
      reserveExit: vi.fn(async () => {
        throw new Error("store write failed");
      }),
      fireOnExit,
      logger: noopLogger,
    });
    w.reconcile([onExitJob("job-a")]);
    await flush();
    expectDefined(runs[0], "runs[0] test invariant").deferred.resolve({
      exitCode: 0,
      reason: "exit",
    });
    await flush();
    expect(fireOnExit).not.toHaveBeenCalled();
    expect(w.activeJobIds()).toEqual([]);
    w.reconcile([onExitJob("job-a")]);
    await flush();
    expect(supervisor.spawn).toHaveBeenCalledTimes(2);
    expect(w.activeJobIds()).toEqual(["job-a"]);
  });

  it("retries with backoff without firing when run.wait() rejects (fail closed on unknown outcome)", async () => {
    const { supervisor, runs } = makeFakeSupervisor();
    const reserveExit = vi.fn(async () => {});
    const fireOnExit = vi.fn(async () => {});
    const updateWatcherState = vi.fn(async () => {});
    const w = createWatcherFixture({
      getProcessSupervisor: () => supervisor as never,
      reserveExit,
      fireOnExit,
      updateWatcherState,
      logger: noopLogger,
      retryBackoffMs: [0],
    });

    w.reconcile([onExitJob("job-a")]);
    await flush();
    expect(supervisor.spawn).toHaveBeenCalledTimes(1);
    expect(w.activeJobIds()).toEqual(["job-a"]);

    // wait() rejects (e.g. supervisor error) instead of resolving with an exit.
    expectDefined(runs[0], "runs[0] test invariant").deferred.reject(
      new Error("supervisor wait blew up"),
    );
    await flush();

    // Fail closed: no fire, no persisted terminal state on an unknown outcome.
    expect(fireOnExit).not.toHaveBeenCalled();
    expect(reserveExit).not.toHaveBeenCalled();
    // The failure is recorded on job state, and the slot stays reserved as the
    // retry placeholder instead of silently dropping the watch.
    expect(updateWatcherState).toHaveBeenCalledWith(
      expect.objectContaining({ id: "job-a" }),
      expect.objectContaining({ consecutiveErrors: 1 }),
    );
    expect(w.activeJobIds()).toEqual(["job-a"]);
    // The backoff timer re-arms without an external reconcile. The 0ms retry
    // timer is armed only after async state persistence, so a fixed sleep races
    // it on loaded CI workers — wait for the re-arm instead.
    await vi.waitFor(() => expect(supervisor.spawn).toHaveBeenCalledTimes(2));
    expect(w.activeJobIds()).toEqual(["job-a"]);
  });

  it("retries with backoff when spawn fails and stops retrying once cancelled", async () => {
    const { supervisor, runs } = makeFakeSupervisor();
    supervisor.spawn.mockRejectedValueOnce(new Error("spawn blew up"));
    const updateWatcherState = vi.fn(async () => {});
    const w = createWatcherFixture({
      getProcessSupervisor: () => supervisor as never,
      reserveExit: vi.fn(async () => {}),
      fireOnExit: vi.fn(async () => {}),
      updateWatcherState,
      logger: noopLogger,
      retryBackoffMs: [0],
    });

    w.reconcile([onExitJob("job-a")]);
    await flush();
    expect(updateWatcherState).toHaveBeenCalledWith(
      expect.objectContaining({ id: "job-a" }),
      expect.objectContaining({ consecutiveErrors: 1 }),
    );
    // Backoff re-arm succeeds on the second spawn. Same async-persist race as
    // the wait-rejection case above: wait for the re-arm, not a fixed sleep.
    await vi.waitFor(() => expect(supervisor.spawn).toHaveBeenCalledTimes(2));
    expect(w.activeJobIds()).toEqual(["job-a"]);

    // Cancelling clears any pending retry timer; once the cancelled child
    // settles, the slot is released and no further spawns happen.
    w.cancel("job-a");
    expectDefined(runs[0], "runs[0] test invariant").deferred.resolve({
      exitCode: null,
      reason: "cancelled",
    });
    await delay(5);
    await flush();
    expect(supervisor.spawn).toHaveBeenCalledTimes(2);
    expect(w.activeJobIds()).toEqual([]);
  });

  it("replaces the watcher when the watched command changes", async () => {
    const { supervisor, cancelledScopes } = makeFakeSupervisor();
    const w = createWatcherFixture({
      getProcessSupervisor: () => supervisor as never,
      reserveExit: vi.fn(async () => {}),
      fireOnExit: vi.fn(async () => {}),
      logger: noopLogger,
    });
    w.reconcile([onExitJob("job-a", "sleep 1")]);
    await flush();
    expect(supervisor.spawn).toHaveBeenCalledTimes(1);
    // Same job id, different command → cancel the stale watcher and re-arm.
    w.reconcile([onExitJob("job-a", "sleep 999")]);
    await flush();
    expect(cancelledScopes).toContain("cron-exit:job-a");
    expect(supervisor.spawn).toHaveBeenCalledTimes(2);
  });

  it("fires with the latest job snapshot when non-schedule fields change", async () => {
    const { supervisor, runs } = makeFakeSupervisor();
    const fireOnExit = vi.fn<FireOnExit>(async () => {});
    const w = createWatcherFixture({
      getProcessSupervisor: () => supervisor as never,
      reserveExit: vi.fn(async () => {}),
      fireOnExit,
      logger: noopLogger,
    });
    w.reconcile([onExitJob("job-a")]);
    await flush();

    w.reconcile([
      {
        ...onExitJob("job-a"),
        payload: { kind: "systemEvent", text: "updated" },
      } as CronJob,
    ]);
    expectDefined(runs[0], "runs[0] test invariant").deferred.resolve({
      exitCode: 0,
      reason: "exit",
    });
    await flush();

    expect(supervisor.spawn).toHaveBeenCalledTimes(1);
    expect(fireOnExit.mock.calls[0]?.[0]).toMatchObject({
      payload: { kind: "systemEvent", text: "updated" },
    });
  });

  it("cancels and kills an in-flight spawn when the job is removed mid-spawn", async () => {
    const fake = makeFakeSupervisor({ deferSpawn: true });
    const fireOnExit = vi.fn(async () => {});
    const w = createWatcherFixture({
      getProcessSupervisor: () => fake.supervisor as never,
      reserveExit: vi.fn(async () => {}),
      fireOnExit,
      logger: noopLogger,
    });
    w.reconcile([onExitJob("job-a")]);
    await flush(); // spawn is awaiting the gate (in flight, untracked child)
    w.reconcile([]); // remove the job while the spawn is in flight
    fake.releaseSpawn(); // spawn now resolves
    await flush();
    await flush();
    // The orphaned child is killed and the job never fires.
    expect(fake.runCancels.length).toBe(1);
    expect(fireOnExit).not.toHaveBeenCalled();
    expect(w.activeJobIds()).toEqual(["job-a"]);
    expectDefined(fake.runs[0], "fake.runs[0] test invariant").deferred.resolve({
      exitCode: null,
      reason: "manual-cancel",
    });
    await vi.waitFor(() => expect(w.activeJobIds()).toEqual([]));
  });

  it("does not arm a watcher for time-based or disabled jobs", async () => {
    const { supervisor } = makeFakeSupervisor();
    const w = createWatcherFixture({
      getProcessSupervisor: () => supervisor as never,
      reserveExit: vi.fn(async () => {}),
      fireOnExit: vi.fn(async () => {}),
      logger: noopLogger,
    });
    const everyJob = {
      ...onExitJob("timer"),
      schedule: { kind: "every", everyMs: 1000 },
    } as unknown as CronJob;
    w.reconcile([everyJob, onExitJob("disabled", "true", false)]);
    await flush();
    expect(supervisor.spawn).not.toHaveBeenCalled();
    expect(w.activeJobIds()).toEqual([]);
  });

  it("is idempotent: re-reconciling the same job does not double-arm", async () => {
    const { supervisor } = makeFakeSupervisor();
    const w = createWatcherFixture({
      getProcessSupervisor: () => supervisor as never,
      reserveExit: vi.fn(async () => {}),
      fireOnExit: vi.fn(async () => {}),
      logger: noopLogger,
    });
    w.reconcile([onExitJob("job-a")]);
    await flush();
    w.reconcile([onExitJob("job-a")]);
    await flush();
    expect(supervisor.spawn).toHaveBeenCalledTimes(1);
  });

  it("keeps a cancelled watcher blocking until the supervised child settles", async () => {
    const { supervisor, cancelled, runs } = makeFakeSupervisor();
    const w = createWatcherFixture({
      getProcessSupervisor: () => supervisor as never,
      reserveExit: vi.fn(async () => {}),
      fireOnExit: vi.fn(async () => {}),
      logger: noopLogger,
    });
    w.reconcile([onExitJob("job-a")]);
    await flush();
    let drained = false;
    const drain = w.cancelAll().then(() => {
      drained = true;
    });
    expect(cancelled).toContain("cron-exit:job-a");
    expect(w.activeJobIds()).toEqual(["job-a"]);
    await flush();
    expect(drained).toBe(false);

    expectDefined(runs[0], "runs[0] test invariant").deferred.resolve({
      exitCode: null,
      reason: "manual-cancel",
    });
    await drain;
    expect(w.activeJobIds()).toEqual([]);
  });

  it("does not fire a job whose watcher was cancelled before exit", async () => {
    const { supervisor, runs } = makeFakeSupervisor();
    const fireOnExit = vi.fn(async () => {});
    const w = createWatcherFixture({
      getProcessSupervisor: () => supervisor as never,
      reserveExit: vi.fn(async () => {}),
      fireOnExit,
      logger: noopLogger,
    });
    w.reconcile([onExitJob("job-a")]);
    await flush();
    w.reconcile([]); // cancel before the command exits
    expectDefined(runs[0], "runs[0] test invariant").deferred.resolve({
      exitCode: 0,
      reason: "manual-cancel",
    });
    await flush();
    expect(fireOnExit).not.toHaveBeenCalled();
  });

  it("retains a blocker and suppresses stale fire when removed during terminal persistence", async () => {
    const { supervisor, runs } = makeFakeSupervisor();
    let releasePersist: () => void = () => {};
    const reserveExit = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releasePersist = resolve;
        }),
    );
    const fireOnExit = vi.fn(async () => {});
    const w = createWatcherFixture({
      getProcessSupervisor: () => supervisor as never,
      reserveExit,
      fireOnExit,
      logger: noopLogger,
    });
    w.reconcile([onExitJob("job-a")]);
    await flush();

    expectDefined(runs[0], "runs[0] test invariant").deferred.resolve({
      exitCode: 0,
      reason: "exit",
    });
    await vi.waitFor(() => expect(reserveExit).toHaveBeenCalledOnce());
    let drained = false;
    const drain = w.cancelAll().then(() => {
      drained = true;
    });
    expect(w.activeJobIds()).toEqual(["job-a"]);
    await flush();
    expect(drained).toBe(false);

    releasePersist();
    await drain;
    expect(w.activeJobIds()).toEqual([]);
    expect(fireOnExit).not.toHaveBeenCalled();
  });

  it("is one-shot: a completed job is not re-armed on a later reconcile", async () => {
    const { supervisor, runs } = makeFakeSupervisor();
    let job = onExitJob("job-a");
    const w = createWatcherFixture({
      getProcessSupervisor: () => supervisor as never,
      reserveExit: vi.fn(async () => {
        job = { ...job, enabled: false };
      }),
      fireOnExit: vi.fn(async () => {}),
      logger: noopLogger,
    });
    w.reconcile([job]);
    await flush();
    expectDefined(runs[0], "runs[0] test invariant").deferred.resolve({
      exitCode: 0,
      reason: "exit",
    });
    await flush();
    w.reconcile([job]);
    await flush();
    expect(supervisor.spawn).toHaveBeenCalledTimes(1);
  });

  it.each(["true", "echo rearmed"])(
    "re-arms %s while the previous payload settles and drains both owners",
    async (command) => {
      const { supervisor, runs } = makeFakeSupervisor();
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
        logger: noopLogger,
      });

      try {
        w.reconcile([job]);
        await flush();
        expectDefined(runs[0], "first watcher").deferred.resolve({
          exitCode: 0,
          reason: "exit",
        });
        await vi.waitFor(() => expect(fireOnExit).toHaveBeenCalledOnce());
        w.reconcile([job]);
        expect(supervisor.spawn).toHaveBeenCalledOnce();

        job = { ...job, enabled: true, schedule: { kind: "on-exit", command } };
        w.reconcile([job]);
        await flush();
        expect(supervisor.spawn).toHaveBeenCalledTimes(2);
        expect(w.activeJobIds()).toEqual([job.id]);
        expectDefined(runs[1], "replacement watcher").deferred.resolve({
          exitCode: 0,
          reason: "exit",
        });
        await flush();
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
        for (const run of runs) {
          run.deferred.resolve({ exitCode: null, reason: "manual-cancel" });
        }
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
        watchers.reconcile([job]);
        await flush();
        expectDefined(runs[0], "first watcher").deferred.resolve({ exitCode: 0, reason: "exit" });
        await vi.waitFor(() => expect(fireOnExit).toHaveBeenCalledOnce());

        for (const command of ["second", "third"]) {
          job = { ...job, enabled: true, schedule: { kind: "on-exit", command } };
          watchers.reconcile([job]);
          await flush();
          expectDefined(runs.at(-1), "replacement watcher").deferred.resolve({
            exitCode: 0,
            reason: "exit",
          });
          await flush();
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
        for (const run of runs) {
          run.deferred.resolve({ exitCode: null, reason: "manual-cancel" });
        }
        await watchers.cancelAll();
      }
    },
  );
});

describe("resolveExitWatchShell", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses cmd.exe on Windows so native gateways without bash can run on-exit", () => {
    const shell = resolveExitWatchShell("win32");
    expect(shell.command).toMatch(/cmd\.exe$/i);
    expect(shell.argsFor("echo hi")).toEqual(["/d", "/s", "/c", "echo hi"]);
  });

  it("uses cmd.exe when ComSpec is blank", () => {
    vi.stubEnv("ComSpec", "   ");
    expect(resolveExitWatchShell("win32").command).toBe("cmd.exe");
  });

  it("uses bash -lc on POSIX", () => {
    expect(resolveExitWatchShell("linux").command).toBe("bash");
    expect(resolveExitWatchShell("linux").argsFor("echo hi")).toEqual(["-lc", "echo hi"]);
    expect(resolveExitWatchShell("darwin").command).toBe("bash");
  });
});
