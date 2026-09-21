import { setImmediate as waitForImmediate } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi, type Mock } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/config.js";
import { CronService } from "../cron/service.js";
import type { CronServiceState } from "../cron/service/state.js";
import { findActiveCronRunReceiptInDatabase } from "../cron/store/run-receipt-store.js";
import type { CronJobCreate } from "../cron/types.js";
import type { HeartbeatRunResult } from "../infra/heartbeat-wake.js";
import type { RunExit } from "../process/supervisor/types.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import type { buildGatewayCronService } from "./server-cron.js";

type CronFixture = ReturnType<typeof buildGatewayCronService>;
type WatchedRun = {
  exit: ReturnType<typeof createDeferred<RunExit>>;
  startedAtMs: number;
  cancel: Mock<() => void>;
  detachOutput: Mock;
  wait: Mock<() => Promise<RunExit>>;
};
type GatewayCronReceiptTestHarness = {
  createWatchedRun: (settleOnCancel: boolean) => WatchedRun;
  mockCronSupervisor: (...runs: WatchedRun[]) => {
    spawn: Mock<() => Promise<WatchedRun & { runId: string }>>;
  };
  createCronConfig: (name: string) => OpenClawConfig;
  loadCronService: (cfg: OpenClawConfig) => CronFixture;
  getCronDeps: (service: CronFixture) => Pick<CronServiceState["deps"], "runCommandJob">;
  getConcreteCron: (service: CronFixture) => CronService;
  addCronJob: (
    service: CronFixture,
    name: string,
    payload: CronJobCreate["payload"],
    overrides?: Partial<Omit<CronJobCreate, "name" | "payload">>,
  ) => ReturnType<CronFixture["cron"]["add"]>;
  runExit: (overrides?: Partial<RunExit>) => RunExit;
};

export function registerGatewayCronReceiptTests({
  createWatchedRun,
  mockCronSupervisor,
  createCronConfig,
  loadCronService,
  getCronDeps,
  getConcreteCron,
  addCronJob,
  runExit,
}: GatewayCronReceiptTestHarness) {
  it.each([
    { rearm: "before timeout", action: "run" },
    { rearm: "after timeout", action: "run" },
    { rearm: "after timeout", action: "disable" },
    { rearm: "after timeout", action: "replace" },
    { rearm: "after timeout", action: "stop" },
  ] as const)(
    "retains an on-exit receipt after rearming $rearm ($action)",
    async ({ rearm, action }) => {
      const watched = [
        createWatchedRun(false),
        createWatchedRun(false),
        createWatchedRun(false),
      ] as const;
      const exits = [watched[0].exit, watched[1].exit, watched[2].exit] as const;
      const runnerStarted = createDeferred();
      const releaseRunner = createDeferred<{ status: "ok"; summary: string }>();
      const callbackReturned = createDeferred();
      const nextCallbackStarted = createDeferred();
      const cleanupGuardRegistered = createDeferred();
      const receiptRecheckRegistered = createDeferred();
      const { spawn } = mockCronSupervisor(...watched);
      const state = loadCronService(createCronConfig("server-cron-on-exit-receipt"));
      const runCommandJob = vi.fn<NonNullable<CronServiceState["deps"]["runCommandJob"]>>(
        async () => ({ status: "ok", summary: "next payload" }),
      );
      runCommandJob.mockImplementationOnce(async () => {
        runnerStarted.resolve();
        return await releaseRunner.promise;
      });
      getCronDeps(state).runCommandJob = runCommandJob;
      const cron = getConcreteCron(state);
      const run = cron.runOnExit.bind(cron);
      const reserved = vi.fn();
      let firstRun = true;
      const runs = vi.spyOn(cron, "runOnExit").mockImplementation(async (id, options) => {
        const first = firstRun;
        firstRun = false;
        if (!first) {
          nextCallbackStarted.resolve();
        }
        try {
          return await run(id, {
            ...options,
            onReserved: () => {
              options.onReserved();
              reserved();
            },
          });
        } finally {
          if (first) {
            callbackReturned.resolve();
          }
        }
      });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const schedule = globalThis.setTimeout;
      const timers = vi
        .spyOn(globalThis, "setTimeout")
        .mockImplementation((callback, delay, ...args) => {
          const timer = schedule(callback, delay, ...args);
          if (delay === 20_000) {
            cleanupGuardRegistered.resolve();
          } else if (delay === 2_000) {
            receiptRecheckRegistered.resolve();
          }
          return timer;
        });
      const reachCleanupGuard = async () => {
        await vi.advanceTimersByTimeAsync(1_000);
        await cleanupGuardRegistered.promise;
        await vi.advanceTimersByTimeAsync(20_000);
      };

      try {
        const job = await addCronJob(
          state,
          "watch through timed-out cleanup",
          { kind: "command", argv: ["true"], timeoutSeconds: 1 },
          { schedule: { kind: "on-exit", command: "true" }, sessionTarget: "isolated" },
        );
        const activeReceipt = () =>
          findActiveCronRunReceiptInDatabase({
            database: openOpenClawStateDatabase().db,
            storePath: state.storePath,
            jobId: job.id,
          });
        await state.reconcileExitWatchers();
        exits[0].resolve(runExit({ reason: "exit", exitCode: 0 }));
        await runnerStarted.promise;
        if (rearm === "after timeout") {
          await reachCleanupGuard();
          await callbackReturned.promise;
          await waitForImmediate();
        }
        await state.cron.update(job.id, { enabled: true });
        await state.reconcileExitWatchers();
        expect(spawn).toHaveBeenCalledTimes(2);
        exits[1].resolve(runExit({ reason: "exit", exitCode: 0 }));
        if (rearm === "before timeout") {
          await reachCleanupGuard();
        }
        await callbackReturned.promise;
        const handoff = expectDefined(await state.prepareExitWatcherHandoff?.(), "watcher handoff");
        await nextCallbackStarted.promise;
        expect(runs).toHaveBeenCalledTimes(2);
        await receiptRecheckRegistered.promise;
        await waitForImmediate();
        expect(activeReceipt()).toBeDefined();
        expect(state.cron.getJob(job.id)?.enabled).toBe(true);
        expect(runCommandJob).toHaveBeenCalledOnce();
        expect(reserved).toHaveBeenCalledOnce();

        if (action === "run") {
          await state.cron.update(job.id, {
            payload: { kind: "command", argv: ["echo", "latest"] },
          });
        } else if (action === "disable") {
          await state.cron.update(job.id, { enabled: false });
        } else if (action === "replace") {
          await state.cron.update(job.id, {
            enabled: true,
            schedule: { kind: "on-exit", command: "echo latest" },
          });
          await state.reconcileExitWatchers();
          expect(spawn).toHaveBeenCalledTimes(3);
          exits[2].resolve(runExit({ reason: "exit", exitCode: 0 }));
        } else if (action === "stop") {
          state.cron.stop();
        }
        expect(activeReceipt()).toBeDefined();
        if (action === "disable" || action === "stop") {
          await handoff.current().cancelAll();
          expect(handoff.current().activeJobIds()).toEqual([]);
        }
        releaseRunner.resolve({ status: "ok", summary: "late cleanup completed" });
        if (action === "run" || action === "replace") {
          // The registered receipt owner rechecks active fences every two seconds.
          await vi.advanceTimersByTimeAsync(2_000);
          await vi.waitFor(() => expect(runCommandJob).toHaveBeenCalledTimes(2), {
            timeout: 5_000,
          });
          await vi.waitFor(() => expect(activeReceipt()).toBeUndefined());
          expect(reserved).toHaveBeenCalledTimes(2);
          if (action === "run") {
            expect(runCommandJob.mock.calls[1]?.[0].job.payload).toMatchObject({
              kind: "command",
              argv: ["echo", "latest"],
            });
          }
          expect(state.cron.getJob(job.id)?.enabled).toBe(false);
          expect(state.cron.getJob(job.id)?.state.lastRunStatus).toBe("ok");
        } else {
          await vi.waitFor(() => expect(activeReceipt()).toBeUndefined());
          expect(reserved).toHaveBeenCalledOnce();
          expect(runCommandJob).toHaveBeenCalledOnce();
        }
      } finally {
        releaseRunner.resolve({ status: "ok", summary: "cleanup" });
        for (const exit of exits) {
          exit.resolve(runExit());
        }
        try {
          await state.cron.stopAndDrain?.();
        } finally {
          timers.mockRestore();
          vi.useRealTimers();
        }
      }
    },
  );
}

export function registerGatewayCronHandoffTests({
  createWatchedRun,
  mockCronSupervisor,
  createCronConfig,
  loadCronService,
  getConcreteCron,
  addCronJob,
  runExit,
  requestHeartbeatAndWaitMock,
  enqueueSystemEventMock,
}: Omit<GatewayCronReceiptTestHarness, "getCronDeps"> & {
  requestHeartbeatAndWaitMock: Mock<(...args: unknown[]) => Promise<HeartbeatRunResult>>;
  enqueueSystemEventMock: Mock;
}) {
  it.each(["start", "start failure", "stop"] as const)(
    "holds adopted on-exit work until the previous scheduler drains (%s)",
    async (outcome) => {
      const watched = [createWatchedRun(false), createWatchedRun(false)] as const;
      const exits = [watched[0].exit, watched[1].exit] as const;
      const releaseFirst = createDeferred();
      const releaseSecond = createDeferred();
      const { spawn } = mockCronSupervisor(...watched);
      requestHeartbeatAndWaitMock
        .mockImplementationOnce(async () => {
          await releaseFirst.promise;
          return { status: "ran", durationMs: 1 };
        })
        .mockImplementationOnce(async () => {
          await releaseSecond.promise;
          return { status: "ran", durationMs: 1 };
        });
      const cfg = createCronConfig("server-cron-on-exit-handoff");
      // Only the two on-exit wakes belong to this handoff fixture.
      cfg.agents = { defaults: { heartbeat: { every: "0m" } } };
      const previous = loadCronService(cfg);
      const start =
        outcome === "start failure"
          ? vi
              .spyOn(CronService.prototype, "start")
              .mockRejectedValueOnce(new Error("start failed"))
          : undefined;
      const next = loadCronService(cfg);
      const nextRun = vi.spyOn(getConcreteCron(next), "runOnExit");
      let adoption: void | Promise<void> = undefined;
      try {
        const jobs = [];
        for (const name of ["first", "second"]) {
          jobs.push(
            await addCronJob(
              previous,
              name,
              { kind: "systemEvent", text: "done" },
              {
                schedule: { kind: "on-exit", command: "true" },
                sessionTarget: "main",
                wakeMode: "now",
              },
            ),
          );
        }
        await previous.reconcileExitWatchers();
        expect(spawn).toHaveBeenCalledTimes(2);
        exits[0].resolve(runExit({ reason: "exit", exitCode: 0 }));
        await vi.waitFor(() => expect(requestHeartbeatAndWaitMock).toHaveBeenCalledOnce());
        const oldHandoff = expectDefined(
          await previous.prepareExitWatcherHandoff?.(),
          "previous handoff",
        );
        const nextHandoff = expectDefined(await next.prepareExitWatcherHandoff?.(), "next handoff");
        adoption = nextHandoff.adopt(oldHandoff.current());
        exits[1].resolve(
          runExit({ reason: "exit", exitCode: 7, stdout: "completed before reload" }),
        );
        await waitForImmediate();
        expect(nextRun).not.toHaveBeenCalled();
        expect(requestHeartbeatAndWaitMock).toHaveBeenCalledOnce();

        releaseFirst.resolve();
        await adoption;
        await oldHandoff.stopOwner();
        expect(nextRun).not.toHaveBeenCalled();
        expect(requestHeartbeatAndWaitMock).toHaveBeenCalledOnce();
        const secondId = expectDefined(jobs[1], "second job").id;
        if (outcome !== "stop") {
          if (outcome === "start failure") {
            await expect(next.cron.start()).rejects.toThrow("start failed");
            expect(requestHeartbeatAndWaitMock).toHaveBeenCalledOnce();
          }
          await next.cron.start();
          await vi.waitFor(() => expect(requestHeartbeatAndWaitMock).toHaveBeenCalledTimes(2));
          expect(requestHeartbeatAndWaitMock).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({ reason: "cron:" + secondId }),
            expect.anything(),
          );
          releaseSecond.resolve();
          await vi.waitFor(() =>
            expect(next.cron.getJob(secondId)?.state.lastRunStatus).toBe("ok"),
          );
          expect(enqueueSystemEventMock).toHaveBeenLastCalledWith(
            expect.stringContaining("completed before reload"),
            expect.anything(),
          );
          expect(spawn).toHaveBeenCalledTimes(2);
        } else {
          await next.cron.stopAndDrain?.();
          expect(requestHeartbeatAndWaitMock).toHaveBeenCalledOnce();
          expect(
            (await next.cron.list({ includeDisabled: true })).find((job) => job.id === secondId)
              ?.enabled,
          ).toBe(true);
          expect(nextHandoff.current().activeJobIds()).toEqual([]);
        }
      } finally {
        releaseFirst.resolve();
        releaseSecond.resolve();
        for (const exit of exits) {
          exit.resolve(runExit());
        }
        await adoption;
        await next.cron.stopAndDrain?.();
        await previous.cron.stopAndDrain?.();
        start?.mockRestore();
      }
    },
  );
}
