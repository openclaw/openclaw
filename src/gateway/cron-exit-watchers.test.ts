import { describe, expect, it, vi } from "vitest";
import type { CronJob } from "../cron/types.js";
import { createCronExitWatchers } from "./cron-exit-watchers.js";

type Deferred = { resolve: (exit: { exitCode: number | null; reason: string }) => void };

/**
 * Minimal fake ProcessSupervisor: each spawn returns a run whose wait() is
 * controlled by the test, so we can deterministically drive "command exited".
 */
function makeFakeSupervisor() {
  const runs: { scopeKey?: string; runId: string; deferred: Deferred }[] = [];
  const cancelled: string[] = [];
  let counter = 0;
  const supervisor = {
    spawn: vi.fn(async (input: { scopeKey?: string }) => {
      counter += 1;
      const runId = `run-${counter}`;
      let resolveWait!: (exit: { exitCode: number | null; reason: string }) => void;
      const waitPromise = new Promise<{ exitCode: number | null; reason: string }>((res) => {
        resolveWait = res;
      });
      runs.push({ scopeKey: input.scopeKey, runId, deferred: { resolve: resolveWait } });
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
        cancel: () => {},
      };
    }),
    cancelScope: vi.fn((scopeKey: string) => {
      cancelled.push(scopeKey);
    }),
  };
  return { supervisor, runs, cancelled };
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

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("createCronExitWatchers", () => {
  it("arms a watcher for an enabled on-exit job and fires the job on exit", async () => {
    const { supervisor, runs } = makeFakeSupervisor();
    const enqueueRun = vi.fn(async () => {});
    const w = createCronExitWatchers({
      getProcessSupervisor: () => supervisor as never,
      enqueueRun,
      logger: noopLogger,
    });

    w.reconcile([onExitJob("job-a")]);
    await flush();
    expect(supervisor.spawn).toHaveBeenCalledTimes(1);
    expect(w.activeJobIds()).toEqual(["job-a"]);
    expect(enqueueRun).not.toHaveBeenCalled();

    // Watched command exits → job fires through the run pipeline.
    runs[0].deferred.resolve({ exitCode: 0, reason: "exit" });
    await flush();
    expect(enqueueRun).toHaveBeenCalledWith("job-a");
  });

  it("does not arm a watcher for time-based or disabled jobs", async () => {
    const { supervisor } = makeFakeSupervisor();
    const w = createCronExitWatchers({
      getProcessSupervisor: () => supervisor as never,
      enqueueRun: vi.fn(async () => {}),
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
    const w = createCronExitWatchers({
      getProcessSupervisor: () => supervisor as never,
      enqueueRun: vi.fn(async () => {}),
      logger: noopLogger,
    });
    w.reconcile([onExitJob("job-a")]);
    await flush();
    w.reconcile([onExitJob("job-a")]);
    await flush();
    expect(supervisor.spawn).toHaveBeenCalledTimes(1);
  });

  it("cancels the watcher when the job is removed from the set", async () => {
    const { supervisor, cancelled } = makeFakeSupervisor();
    const w = createCronExitWatchers({
      getProcessSupervisor: () => supervisor as never,
      enqueueRun: vi.fn(async () => {}),
      logger: noopLogger,
    });
    w.reconcile([onExitJob("job-a")]);
    await flush();
    w.reconcile([]);
    expect(cancelled).toContain("cron-exit:job-a");
    expect(w.activeJobIds()).toEqual([]);
  });

  it("does not fire a job whose watcher was cancelled before exit", async () => {
    const { supervisor, runs } = makeFakeSupervisor();
    const enqueueRun = vi.fn(async () => {});
    const w = createCronExitWatchers({
      getProcessSupervisor: () => supervisor as never,
      enqueueRun,
      logger: noopLogger,
    });
    w.reconcile([onExitJob("job-a")]);
    await flush();
    w.reconcile([]); // cancel before the command exits
    runs[0].deferred.resolve({ exitCode: 0, reason: "manual-cancel" });
    await flush();
    expect(enqueueRun).not.toHaveBeenCalled();
  });

  it("is one-shot: a fired job is not re-armed on a later reconcile", async () => {
    const { supervisor, runs } = makeFakeSupervisor();
    const w = createCronExitWatchers({
      getProcessSupervisor: () => supervisor as never,
      enqueueRun: vi.fn(async () => {}),
      logger: noopLogger,
    });
    w.reconcile([onExitJob("job-a")]);
    await flush();
    runs[0].deferred.resolve({ exitCode: 0, reason: "exit" });
    await flush();
    w.reconcile([onExitJob("job-a")]);
    await flush();
    expect(supervisor.spawn).toHaveBeenCalledTimes(1);
  });
});
