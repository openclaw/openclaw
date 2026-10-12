import { setImmediate as waitForImmediate } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi, type Mock } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { createReplyOperation } from "../auto-reply/reply/reply-run-registry.js";
import type { OpenClawConfig } from "../config/config.js";
import { hasActiveCronJobsForAgent, isCronJobActive } from "../cron/active-jobs.js";
import type { CronService } from "../cron/service.js";
import { getSuspensionVisibleCronTaskRunCount } from "../cron/service/active-run-cancellation.js";
import { CRON_AGENT_SETUP_WATCHDOG_MS } from "../cron/service/agent-watchdog.js";
import type { CronServiceState } from "../cron/service/state.js";
import { findActiveCronRunReceiptInDatabase } from "../cron/store/run-receipt-store.js";
import type { CronJob, CronJobCreate } from "../cron/types.js";
import type { GatewayScheduler } from "../infra/gateway-scheduler.js";
import { onGatewayWorkMetricsChanged } from "../infra/gateway-work-metrics-events.js";
import type { RunExit } from "../process/supervisor/types.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import type { buildGatewayCronService } from "./server-cron.js";

type CronFixture = ReturnType<typeof buildGatewayCronService>;
type WatchedRun = {
  exit: ReturnType<typeof createDeferred<RunExit>>;
  startedAtMs: number;
  cancel: Mock<() => void>;
  detachOutput: Mock;
  wait: Mock<() => Promise<RunExit>>;
};
export type GatewayCronReceiptTestHarness = {
  createWatchedRun: (settleOnCancel: boolean) => WatchedRun;
  mockCronSupervisor: (...runs: WatchedRun[]) => {
    spawn: Mock<() => Promise<WatchedRun & { runId: string }>>;
  };
  createCronConfig: (name: string) => OpenClawConfig;
  loadCronService: (
    cfg: OpenClawConfig,
    overrides?: { scheduler: GatewayScheduler },
  ) => CronFixture;
  getCronDeps: (
    service: CronFixture,
  ) => Pick<CronServiceState["deps"], "runCommandJob" | "runSessionEvent">;
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
  getCronState,
  createWatchedRun,
  mockCronSupervisor,
  createCronConfig,
  loadCronService,
  getCronDeps,
  getConcreteCron,
  addCronJob,
  runExit,
}: GatewayCronReceiptTestHarness & { getCronState: (service: CronFixture) => CronServiceState }) {
  it.for([
    { phase: "before admission", action: "run" },
    { phase: "after admission", action: "run" },
    { phase: "after admission", action: "rearm" },
    { phase: "after admission", action: "started error" },
    { phase: "after admission", action: "disable" },
    { phase: "before admission", action: "replace" },
    { phase: "after admission", action: "stop" },
  ] as const)(
    "retains an idle on-exit receipt $phase ($action)",
    async ({ phase, action }, { signal }) => {
      const watched = createWatchedRun(false);
      const rearmed = action === "rearm" ? createWatchedRun(false) : undefined;
      const { spawn } = mockCronSupervisor(watched, ...(rearmed ? [rearmed] : []));
      const clock = createGatewaySchedulerClock(Date.now());
      const state = loadCronService(createCronConfig("server-cron-on-exit-idle"), {
        scheduler: createTestGatewayScheduler(clock.clock),
      });
      const cron = getConcreteCron(state);
      const nativeState = getCronState(state);
      const idleWait = createDeferred();
      const callbackSettled = createDeferred();
      let callbackFinished = false;
      const longWait = phase === "before admission" && action === "run";
      const timedOutCleanup = longWait
        ? vi.spyOn(nativeState.deps, "cleanupTimedOutAgentRun")
        : undefined;
      const idlePolicyChecked = createDeferred();
      const originalIdlePolicy = expectDefined(
        nativeState.deps.isExecutionIdle,
        "Gateway idle policy",
      );
      const idlePolicy = longWait
        ? vi.spyOn(nativeState.deps, "isExecutionIdle").mockImplementation((...args) => {
            const idle = originalIdlePolicy(...args);
            if (
              !idle &&
              !hasActiveCronJobsForAgent("main", undefined, { excludeIdleWaiters: true }) &&
              nativeState.activeManualRunJobIds.size === 1
            ) {
              idlePolicyChecked.resolve();
            }
            return idle;
          })
        : undefined;
      const run = cron.runOnExit.bind(cron);
      const reserved = vi.fn();
      const runOnExit = vi.spyOn(cron, "runOnExit").mockImplementation(async (id, opts) => {
        try {
          return await run(id, {
            ...opts,
            onReserved: () => {
              opts.onReserved();
              reserved();
            },
          });
        } finally {
          callbackFinished = true;
          callbackSettled.resolve();
        }
      });
      let foreground: ReturnType<typeof createReplyOperation> | undefined;
      const beginForeground = () => {
        foreground = createReplyOperation({
          sessionId: "foreground-idle-exit",
          sessionKey: "agent:main:foreground-idle-exit",
          resetTriggered: false,
        });
        foreground.setPhase("running");
      };
      const executionReceipts: string[] = [];
      const payloadStarted = vi.fn();
      const payloadRunner = vi.fn<NonNullable<CronServiceState["deps"]["runSessionEvent"]>>(
        async (request) => {
          const receipt = expectDefined(
            findActiveCronRunReceiptInDatabase({
              database: openOpenClawStateDatabase().db,
              storePath: state.storePath,
              jobId: request.job.id,
            }),
            "payload receipt",
          );
          executionReceipts.push(receipt.receiptId);
          if (phase === "after admission") {
            beginForeground();
            const waitForIdle = expectDefined(
              request.waitForIdle,
              "retained core idle continuation",
            );
            await waitForIdle("agent:main:main");
            const retained = expectDefined(
              findActiveCronRunReceiptInDatabase({
                database: openOpenClawStateDatabase().db,
                storePath: state.storePath,
                jobId: request.job.id,
              }),
              "same receipt after idle wait",
            );
            expect(retained.receiptId).toBe(receipt.receiptId);
          }
          payloadStarted();
          request.onExecutionStarted?.();
          return action === "started error"
            ? { status: "error", error: "payload failed after starting", executionStarted: true }
            : { status: "ok", summary: "completed", executionStarted: true };
        },
      );
      getCronDeps(state).runSessionEvent = payloadRunner;
      let stopObserving = () => {};
      try {
        const job = await addCronJob(
          state,
          "watch and defer",
          { kind: "systemEvent", text: "inspect exit" },
          {
            schedule: { kind: "on-exit", command: "watched-command" },
            sessionTarget: "main",
            idleOnly: true,
            deleteAfterRun: false,
          },
        );
        stopObserving = onGatewayWorkMetricsChanged(() =>
          queueMicrotask(() => {
            if (
              isCronJobActive(job.id) &&
              !hasActiveCronJobsForAgent("main", undefined, { excludeIdleWaiters: true })
            ) {
              idleWait.resolve();
            }
          }),
        );
        if (phase === "before admission") {
          beginForeground();
        }
        await state.reconcileExitWatchers();
        if (longWait) {
          vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        }
        watched.exit.resolve(
          runExit({
            exitCode: 7,
            stdout: "exact retained stdout",
            stderr: "exact retained stderr",
          }),
        );
        await withinTest(
          awaitGateBeforeSettlement(
            idleWait.promise,
            callbackSettled.promise,
            "on-exit callback consumed the idle refusal instead of retaining the exit",
          ),
          signal,
        );
        const receipt = expectDefined(
          findActiveCronRunReceiptInDatabase({
            database: openOpenClawStateDatabase().db,
            storePath: state.storePath,
            jobId: job.id,
          }),
          "retained idle receipt",
        );
        expect(state.cron.getJob(job.id)?.enabled).toBe(false);
        expect(state.cron.getJob(job.id)?.state.lastRunStatus).toBeUndefined();
        expect(hasActiveCronJobsForAgent("main", undefined, { excludeIdleWaiters: true })).toBe(
          false,
        );
        expect(isCronJobActive(job.id)).toBe(true);
        expect(getSuspensionVisibleCronTaskRunCount({ agentId: "main" })).toBeGreaterThan(0);
        expect(reserved).toHaveBeenCalledOnce();
        expect(spawn).toHaveBeenCalledOnce();
        expect(payloadRunner).toHaveBeenCalledTimes(phase === "before admission" ? 0 : 1);
        expect(payloadStarted).not.toHaveBeenCalled();
        if (longWait) {
          await withinTest(
            awaitGateBeforeSettlement(
              idlePolicyChecked.promise,
              callbackSettled.promise,
              "retained core settled before its suspended idle check",
            ),
            signal,
          );
          await vi.advanceTimersByTimeAsync(CRON_AGENT_SETUP_WATCHDOG_MS + 1);
          expect(timedOutCleanup).not.toHaveBeenCalled();
          expect(callbackFinished).toBe(false);
          expect(payloadRunner).not.toHaveBeenCalled();
          expect(state.cron.getJob(job.id)?.state.lastRunStatus).toBeUndefined();
          expect(hasActiveCronJobsForAgent("main", undefined, { excludeIdleWaiters: true })).toBe(
            false,
          );
          expect(
            findActiveCronRunReceiptInDatabase({
              database: openOpenClawStateDatabase().db,
              storePath: state.storePath,
              jobId: job.id,
            })?.receiptId,
          ).toBe(receipt.receiptId);
        }

        if (action === "rearm") {
          await state.cron.update(job.id, { enabled: true });
          await state.reconcileExitWatchers();
          expect(spawn).toHaveBeenCalledTimes(2);
          expect(
            findActiveCronRunReceiptInDatabase({
              database: openOpenClawStateDatabase().db,
              storePath: state.storePath,
              jobId: job.id,
            })?.receiptId,
          ).toBe(receipt.receiptId);
          foreground?.complete();
        } else if (action === "disable") {
          await state.cron.update(job.id, { enabled: false });
        } else if (action === "replace") {
          await state.cron.update(job.id, {
            schedule: { kind: "on-exit", command: "replacement-command" },
          });
          await state.reconcileExitWatchers();
        } else if (action === "stop") {
          state.cron.stop();
        } else {
          foreground?.complete();
        }
        await withinTest(callbackSettled.promise, signal);
        const executed = action === "run" || action === "rearm" || action === "started error";
        expect(payloadRunner).toHaveBeenCalledTimes(
          phase === "after admission" || executed ? 1 : 0,
        );
        expect(payloadStarted).toHaveBeenCalledTimes(executed ? 1 : 0);
        if (executed) {
          expect(executionReceipts.every((id) => id === receipt.receiptId)).toBe(true);
          expect(payloadRunner.mock.calls.at(-1)?.[0].text).toContain("exact retained stdout");
          expect(payloadRunner.mock.calls.at(-1)?.[0].text).toContain("exact retained stderr");
          expect(state.cron.getJob(job.id)?.state.lastRunStatus).toBe(
            action === "started error" ? "error" : "ok",
          );
        }
        expect(reserved).toHaveBeenCalledOnce();
        expect(spawn).toHaveBeenCalledTimes(action === "rearm" ? 2 : 1);
        if (action === "rearm") {
          expect(state.cron.getJob(job.id)?.enabled).toBe(true);
          expect(runOnExit).toHaveBeenCalledOnce();
        }
        expect(
          findActiveCronRunReceiptInDatabase({
            database: openOpenClawStateDatabase().db,
            storePath: state.storePath,
            jobId: job.id,
          }),
        ).toBeUndefined();
        expect(isCronJobActive(job.id)).toBe(false);
      } finally {
        stopObserving();
        timedOutCleanup?.mockRestore();
        idlePolicy?.mockRestore();
        if (longWait) {
          vi.useRealTimers();
        }
        foreground?.complete();
        watched.exit.resolve(runExit());
        if (rearmed) {
          state.cron.stop();
          rearmed.exit.resolve(runExit());
        }
        await state.cron.stopAndDrain?.();
        runOnExit.mockRestore();
      }
    },
  );

  it("serializes two retained idle exits without blocking their shared agent forever", async ({
    signal,
  }) => {
    const watched = [createWatchedRun(false), createWatchedRun(false)];
    const { spawn } = mockCronSupervisor(...watched);
    const state = loadCronService(createCronConfig("server-cron-two-idle-exits"));
    const cron = getConcreteCron(state);
    const bothWaiting = createDeferred();
    const firstStarted = createDeferred();
    const releaseFirst = createDeferred();
    const bothSettled = createDeferred();
    const foreground = createReplyOperation({
      sessionId: "foreground-two-exits",
      sessionKey: "agent:main:foreground-two-exits",
      resetTriggered: false,
    });
    foreground.setPhase("running");
    const run = cron.runOnExit.bind(cron);
    let settled = 0;
    const runOnExit = vi.spyOn(cron, "runOnExit").mockImplementation(async (...args) => {
      try {
        return await run(...args);
      } finally {
        if (++settled === 2) {
          bothSettled.resolve();
        }
      }
    });
    let started = 0;
    const payloadRunner = vi.fn<NonNullable<CronServiceState["deps"]["runSessionEvent"]>>(
      async (request) => {
        request.onExecutionStarted?.();
        if (++started === 1) {
          firstStarted.resolve();
          await releaseFirst.promise;
        }
        return { status: "ok", summary: "completed", executionStarted: true };
      },
    );
    getCronDeps(state).runSessionEvent = payloadRunner;
    let stopObserving = () => {};
    try {
      const jobs: CronJob[] = [];
      for (const name of ["first-exit", "second-exit"]) {
        jobs.push(
          await addCronJob(
            state,
            name,
            { kind: "systemEvent", text: name },
            {
              schedule: { kind: "on-exit", command: name },
              sessionTarget: "main",
              idleOnly: true,
              deleteAfterRun: false,
            },
          ),
        );
      }
      stopObserving = onGatewayWorkMetricsChanged(() =>
        queueMicrotask(() => {
          if (
            jobs.every((job) => isCronJobActive(job.id)) &&
            !hasActiveCronJobsForAgent("main", undefined, { excludeIdleWaiters: true })
          ) {
            bothWaiting.resolve();
          }
        }),
      );
      await state.reconcileExitWatchers();
      for (const [index, watcher] of watched.entries()) {
        watcher.exit.resolve(runExit({ stdout: `retained-exit-${index}` }));
      }
      await withinTest(
        awaitGateBeforeSettlement(
          bothWaiting.promise,
          bothSettled.promise,
          "idle exits completed instead of retaining both source events",
        ),
        signal,
      );
      expect(payloadRunner).not.toHaveBeenCalled();
      expect(hasActiveCronJobsForAgent("main", undefined, { excludeIdleWaiters: true })).toBe(
        false,
      );
      expect(getSuspensionVisibleCronTaskRunCount({ agentId: "main" })).toBe(2);
      foreground.complete();
      await withinTest(
        awaitGateBeforeSettlement(
          firstStarted.promise,
          bothSettled.promise,
          "retained exits settled without executing either payload",
        ),
        signal,
      );
      expect(payloadRunner).toHaveBeenCalledOnce();
      releaseFirst.resolve();
      await withinTest(bothSettled.promise, signal);
      expect(payloadRunner).toHaveBeenCalledTimes(2);
      expect(spawn).toHaveBeenCalledTimes(2);
      expect(payloadRunner.mock.calls.map(([request]) => request.job.id).toSorted()).toEqual(
        jobs.map((job) => job.id).toSorted(),
      );
      for (const [index, job] of jobs.entries()) {
        expect(
          payloadRunner.mock.calls.find(([request]) => request.job.id === job.id)?.[0].text,
        ).toContain(`retained-exit-${index}`);
        expect(state.cron.getJob(job.id)?.state.lastRunStatus).toBe("ok");
        expect(isCronJobActive(job.id)).toBe(false);
      }
    } finally {
      stopObserving();
      foreground.complete();
      releaseFirst.resolve();
      for (const watcher of watched) {
        watcher.exit.resolve(runExit());
      }
      await state.cron.stopAndDrain?.();
      runOnExit.mockRestore();
    }
  });

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
      const clock = createGatewaySchedulerClock(Date.now());
      const scheduler = createTestGatewayScheduler({
        ...clock.clock,
        arm: (run, delayMs) => {
          const cancel = clock.clock.arm(run, delayMs);
          if (delayMs === 2_000) {
            receiptRecheckRegistered.resolve();
          }
          return cancel;
        },
      });
      const state = loadCronService(createCronConfig("server-cron-on-exit-receipt"), { scheduler });
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
        // Worker receipt completion must settle before the separate polling clock advances.
        await vi.waitFor(() => expect(activeReceipt()).toBeUndefined());
        if (action === "run" || action === "replace") {
          // The registered receipt owner rechecks active fences every two seconds.
          await vi.advanceTimersByTimeAsync(2_000);
          await clock.advanceBy(2_000);
          await vi.waitFor(() => expect(runCommandJob).toHaveBeenCalledTimes(2), {
            timeout: 5_000,
          });
          await vi.waitFor(() => expect(activeReceipt()).toBeUndefined());
          expect(reserved).toHaveBeenCalledTimes(2);
          const completion = expectDefined(runs.mock.results.at(-1), "rearmed on-exit run");
          if (completion.type !== "return") {
            throw new Error("Rearmed on-exit run did not return a completion");
          }
          await completion.value;
          if (action === "run") {
            expect(runCommandJob.mock.calls[1]?.[0].job.payload).toMatchObject({
              kind: "command",
              argv: ["echo", "latest"],
            });
          }
          expect(state.cron.getJob(job.id)?.enabled).toBe(false);
          expect(state.cron.getJob(job.id)?.state.lastRunStatus).toBe("ok");
        } else {
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
