// Gateway run loop tests cover foreground gateway lifecycle and restart behavior.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { GatewayServer, GatewayStartupOperation } from "../../gateway/server-public.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { resolveGlobalMap } from "../../shared/global-singleton.js";
import { captureEnv } from "../../test-utils/env.js";
import { registerExternalHandoffShutdownTests } from "./run-loop-external-handoff.test-support.js";
import { registerHostedUpdateStopTests } from "./run-loop-hosted-stop.test-support.js";
import { gatewayWorkAdmissionActual, runLoopFixture } from "./run-loop-mocks.test-support.js";
import { registerGatewayRequestTests } from "./run-loop-request.test-support.js";
import { registerShutdownBudgetTests } from "./run-loop-shutdown-budget.test-support.js";
import {
  registerGracefulGatewayShutdownTests,
  registerShutdownCompletionTests,
} from "./run-loop-shutdown-completion.test-support.js";
import { registerGatewayStartupFailureTests } from "./run-loop-startup.test-support.js";
import { registerUpdateRespawnTests } from "./run-loop-update-respawn.test-support.js";
import {
  createActiveWorkSnapshot,
  createCloseMock,
  createGatewayServer,
  createRuntimeWithExitSignal,
  createSignaledStart,
  createUpdateRespawnChild,
  expectRestartCloseCall,
  originalPlatformDescriptor,
  registerUpdateRespawnProgressTests,
  registerGatewayRestartOwnershipTests,
  setPlatform,
  waitForStart,
  waitForLoopCondition,
  withIsolatedSignals,
} from "./run-loop.test-support.js";

const {
  closeLogTempDirs,
  systemctl,
  stopManagedProviderLocalServices,
  hasManagedProviderLocalServices,
  readLaunchdStopTimeout,
  acquireGatewayLock,
  hostedStopExecute,
  hostedStopDispose,
  consumeGatewayRestartIntentPayloadSync,
  consumeGatewayRestartIntent,
  cancelManagedServiceUpdateHandoff,
  requestManagedServiceUpdateHandoffPark,
  commitManagedServiceUpdateHandoff,
  consumeGatewayRestartAuthorization,
  isGatewayRestartExternallyAllowed,
  markGatewayRestartHandled,
  peekGatewayRestartReason,
  resetGatewayRestartStateForInProcessRestart,
  resetGatewaySuspendCoordinatorForLifecycleRestart,
  rollbackGatewayRestartSignalAdmission,
  writeGatewayRestartHandoffSync,
  scheduleGatewayRestart,
  idleActiveWorkSnapshot,
  createGatewayActiveWorkSnapshot,
  waitForGatewayActiveWork,
  advanceCronActiveJobGeneration,
  resetCronActiveJobs,
  abortActiveCronTaskRuns,
  retireActiveCronTaskRunTracking,
  waitForActiveCronTaskRuns,
  waitForActiveCronJobs,
  clearRuntimeConfigSnapshot,
  restartGatewayProcessWithFreshPid,
  respawnGatewayProcessForUpdate,
  markUpdateRestartSentinelFailure,
  waitForGatewayHealthyRestart,
  respawnHealth,
  abortPendingChannelReloads,
  abortEmbeddedAgentRun,
  gatewayLog,
  flushLogger,
  writeDiagnosticStabilityBundleForFailureSync,
  runLoopWithStart,
  createSignaledLoopHarness,
  expectRestartHandoffCall,
} = runLoopFixture;

const managedUpdateSuccessorOwner = {
  kind: "managed-update-handoff",
  handoffId: "handoff-under-test",
  installRoot: "/openclaw/install",
} as const;

const fixtures = {
  ...runLoopFixture,
  managedUpdateSuccessorOwner,
  isGatewayWorkAdmissionClosed: () => gatewayWorkAdmissionActual.isGatewayWorkAdmissionClosed(),
  withIsolatedSignals,
  createSignaledStart,
  createRuntimeWithExitSignal,
  waitForStart,
  waitForLoopCondition,
  setPlatform,
  originalPlatformDescriptor,
};

const DEFAULT_RESTART_DEFERRAL_TIMEOUT_MS = 300_000;

type GatewayCloseFn = GatewayServer["close"];

function waitForLoopTurn() {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

describe("runGatewayLoop", () => {
  registerGatewayRequestTests(fixtures);

  registerExternalHandoffShutdownTests(fixtures, DEFAULT_RESTART_DEFERRAL_TIMEOUT_MS);

  it("does not grant process control to a nonexclusive embedded host", async () => {
    await withIsolatedSignals(async ({ captureSignal }) => {
      const { start, close, exited, runtime } = await createSignaledLoopHarness();
      const host = start.mock.calls[0]?.[0]?.hostLifecycle;
      await expect(host!.request("start", () => {})).resolves.toMatchObject({
        ok: true,
        value: { outcome: "already-running" },
      });
      for (const action of ["stop", "restart"] as const) {
        await expect(host!.request(action, () => {})).resolves.toMatchObject({
          ok: false,
          error: expect.stringContaining("does not own the process lifecycle"),
        });
      }
      expect(close).not.toHaveBeenCalled();
      expect(runtime.exit).not.toHaveBeenCalled();
      expect(hostedStopExecute).not.toHaveBeenCalled();
      captureSignal("SIGINT")();
      await expect(exited).resolves.toBe(0);
    });
  });

  it("retains the initiating root through response submission and joins before native stop", async () => {
    await withIsolatedSignals(async () => {
      const { close, start, exited } = await createSignaledLoopHarness(undefined, true);
      const startOptions = start.mock.calls[0]?.[0];
      const host = startOptions?.hostLifecycle;
      expect(host).toBeDefined();
      const requestFinished = createDeferredCore();
      const joined = createDeferredCore();
      close.mockImplementationOnce(() => joined.promise);
      waitForGatewayActiveWork.mockImplementationOnce(async () => {
        // excludeCurrent must not hide the original RPC when shutdown begins.
        expect(
          gatewayWorkAdmissionActual.getActiveGatewayRootWorkCount({ excludeCurrent: true }),
        ).toBe(1);
        await requestFinished.promise;
        expect(gatewayWorkAdmissionActual.getActiveGatewayRootWorkCount()).toBe(0);
        return { drained: true, snapshot: idleActiveWorkSnapshot };
      });
      try {
        await gatewayWorkAdmissionActual.runWithGatewayIndependentRootWorkAdmission(async () => {
          await expect(host!.request("stop", () => {})).resolves.toEqual({
            ok: true,
            value: { outcome: "scheduled" },
          });
          // Audit/history/response work remains in the admitted handler after acceptance.
          await Promise.resolve();
          expect(gatewayWorkAdmissionActual.getActiveGatewayRootWorkCount()).toBe(1);
          expect(close).not.toHaveBeenCalled();
          expect(hostedStopExecute).not.toHaveBeenCalled();
        }, "rpc:system-agent.chat");
        requestFinished.resolve();
        await waitForLoopCondition(
          () => close.mock.calls.length === 1,
          "hosted stop did not reach teardown",
        );
        expect(hostedStopExecute).not.toHaveBeenCalled();
        joined.resolve();
        await expect(exited).resolves.toBe(0);
        expect(waitForGatewayActiveWork).toHaveBeenCalledWith(315_000, {
          onSnapshot: expect.any(Function),
        });
        expect(hostedStopExecute).toHaveBeenCalledOnce();
        await expect(host!.request("start", () => {})).resolves.toMatchObject({ ok: false });
      } finally {
        requestFinished.resolve();
        joined.resolve();
      }
    });
  });

  registerHostedUpdateStopTests(fixtures);

  it.each([
    { outcome: "refused", detail: "same native generation; stop denied" },
    { outcome: "uncertain", detail: "native acknowledgement lost" },
  ] as const)("recovers only after a definitive native stop refusal ($outcome)", async (result) => {
    await withIsolatedSignals(async ({ captureSignal }) => {
      hostedStopExecute.mockResolvedValueOnce(result);
      const disposed = createDeferredCore();
      hostedStopDispose.mockImplementationOnce(() => disposed.promise);
      const { start, exited, runtime } = await createSignaledLoopHarness(undefined, true);
      const host = start.mock.calls[0]![0]!.hostLifecycle!;
      try {
        await host.request("stop", () => {});
        await waitForLoopCondition(
          () => hostedStopDispose.mock.calls.length === 1,
          "executor cleanup did not start",
        );
        expect(start).toHaveBeenCalledOnce();
        expect(runtime.exit).not.toHaveBeenCalled();
        disposed.resolve();
        if (result.outcome === "refused") {
          await waitForLoopCondition(
            () => start.mock.calls.length === 2,
            "native refusal left a closed Gateway instead of restarting in process",
          );
          expect(runtime.exit).not.toHaveBeenCalled();
          await expect(host.request("restart", () => {})).resolves.toMatchObject({ ok: false });
          captureSignal("SIGINT")();
        }
        await expect(exited).resolves.toBe(result.outcome === "refused" ? 0 : 1);
        expect(start).toHaveBeenCalledTimes(result.outcome === "refused" ? 2 : 1);
        expect(gatewayLog.error).toHaveBeenCalledWith(expect.stringContaining(result.detail));
      } finally {
        disposed.resolve();
      }
    });
  });

  it("rejects an unclean replacement acquisition before admitting another lifecycle", async () => {
    await withIsolatedSignals(async ({ captureSignal }) => {
      const { GatewayStartupCleanupError } = await import("../../gateway/server-shutdown.js");
      const { runGatewayLoop } = await import("./run-loop.js");
      const startupError = new Error("replacement listener failed");
      const cleanupError = new Error("replacement required cleanup failed");
      const failure = new GatewayStartupCleanupError(startupError, cleanupError);
      let lockCallsAtFailure = 0;
      let cancellationsAtFailure = 0;
      let commitsAtFailure = 0;
      const start = vi
        .fn<Parameters<typeof runGatewayLoop>[0]["start"]>()
        .mockResolvedValueOnce(createGatewayServer(createCloseMock()))
        .mockImplementationOnce(async () => {
          lockCallsAtFailure = acquireGatewayLock.mock.calls.length;
          cancellationsAtFailure = cancelManagedServiceUpdateHandoff.mock.calls.length;
          commitsAtFailure = commitManagedServiceUpdateHandoff.mock.calls.length;
          throw failure;
        });
      const { runtime, exited } = createRuntimeWithExitSignal();
      const completeBoot = vi.fn();
      const onRestartStartupFailure = vi.fn();
      const loop = runGatewayLoop({ start, runtime, completeBoot, onRestartStartupFailure });
      const rejected = vi.fn<(error: unknown) => void>();
      const settled = loop.catch(rejected);
      let stop: (() => void) | undefined;
      try {
        await waitForLoopCondition(() => start.mock.calls.length === 1, "expected first startup");
        // The first generation has completed startup before its restart is requested.
        await waitForLoopTurn();
        stop = captureSignal("SIGTERM");
        captureSignal("SIGUSR2")();
        await waitForLoopCondition(
          () =>
            rejected.mock.calls.length > 0 ||
            gatewayLog.error.mock.calls.some(([message]) =>
              String(message).startsWith("gateway startup failed:"),
            ),
          "expected replacement acquisition failure",
        );
        expect(rejected).toHaveBeenCalledExactlyOnceWith(failure);
        await expect(loop).rejects.toBe(failure);
        expect(start).toHaveBeenCalledTimes(2);
        expect(onRestartStartupFailure).not.toHaveBeenCalled();
        expect(acquireGatewayLock).toHaveBeenCalledTimes(lockCallsAtFailure);
        expect(cancelManagedServiceUpdateHandoff).toHaveBeenCalledTimes(cancellationsAtFailure);
        expect(commitManagedServiceUpdateHandoff).toHaveBeenCalledTimes(commitsAtFailure);
        expect(completeBoot).toHaveBeenCalledWith({
          outcome: "startup_failed",
          reason: expect.stringContaining(startupError.message),
        });
        expect(runtime.exit).not.toHaveBeenCalled();
      } finally {
        if (rejected.mock.calls.length === 0 && stop) {
          stop();
          await exited;
        }
        if (rejected.mock.calls.length > 0) {
          await settled;
        }
      }
    });
  });

  it("cancels and joins triage before stopping a failed in-process restart", async () => {
    await withIsolatedSignals(async ({ captureSignal }) => {
      const startedTriage = createDeferred();
      const cleanup = createDeferred();
      let triageSignal: AbortSignal | undefined;
      const start = vi
        .fn()
        .mockResolvedValueOnce(createGatewayServer(createCloseMock()))
        .mockRejectedValueOnce(new Error("replacement startup failed"));
      const { runtime, exited } = createRuntimeWithExitSignal();
      const { runGatewayLoop } = await import("./run-loop.js");
      void runGatewayLoop({
        start,
        runtime,
        onRestartStartupFailure: async (_error, signal) => {
          triageSignal = signal;
          startedTriage.resolve();
          await cleanup.promise;
        },
      });
      await waitForLoopCondition(() => start.mock.calls.length === 1, "expected initial Gateway");
      captureSignal("SIGUSR2")();
      await startedTriage.promise;
      captureSignal("SIGINT")();
      try {
        expect(triageSignal?.aborted).toBe(true);
        expect(runtime.exit).not.toHaveBeenCalled();
      } finally {
        cleanup.resolve();
      }
      await expect(exited).resolves.toBe(0);
      expect(start).toHaveBeenCalledTimes(2);
    });
  });

  registerGatewayStartupFailureTests(gatewayLog);

  registerGracefulGatewayShutdownTests(fixtures);

  it.each(["close", "native stop"])(
    "records the thrown %s error during a hosted stop",
    async (step) => {
      await withIsolatedSignals(async () => {
        const error = new TypeError("fixture hosted stop failed");
        const { close, start, exited } = await createSignaledLoopHarness(undefined, true);
        if (step === "close") {
          close.mockRejectedValueOnce(error);
        } else {
          hostedStopExecute.mockRejectedValueOnce(error);
        }
        const host = start.mock.calls[0]?.[0]?.hostLifecycle;
        expect(host).toBeDefined();
        await expect(host?.request("stop", () => {})).resolves.toMatchObject({ ok: true });
        await expect(exited).resolves.toBe(1);
        expect(writeDiagnosticStabilityBundleForFailureSync).toHaveBeenCalledWith(
          step === "close" ? "gateway.stop_close_failed" : "gateway.stop_native_unconfirmed",
          error,
          { shutdownStep: step === "close" ? "gateway-server-close" : "hosted-gateway-stop" },
        );
      });
    },
  );

  it("persists an issued close-error log append before forced exit", async () => {
    const logger =
      await vi.importActual<typeof import("../../logging/logger.js")>("../../logging/logger.js");
    const { fileLogTransport } = await import("../../logging/logger-file-transport.js");
    const { appendRegularFile } = await import("@openclaw/fs-safe/advanced");
    const logFile = join(closeLogTempDirs.make("openclaw-close-log-"), "gateway.jsonl");
    const appendAllowed = createDeferredCore();
    logger.setLoggerOverride({ level: "info", file: logFile });
    const fileLogger = logger.getChildLogger({ subsystem: "gateway" });
    fileLogTransport.setAppenderForTests(async (options) => {
      await appendAllowed.promise;
      return appendRegularFile(options);
    });
    gatewayLog.error.mockImplementation((message: string) => {
      fileLogger.error(message);
      void logger.flushLogger();
    });
    flushLogger.mockImplementation(() => logger.flushLogger());
    try {
      await withIsolatedSignals(async ({ captureSignal }) => {
        const close = vi.fn<GatewayCloseFn>(() => {
          throw new TypeError("close owner failed");
        });
        const { start, started } = createSignaledStart(close);
        const { runtime, exited } = createRuntimeWithExitSignal();
        const exit = runtime.exit.getMockImplementation();
        let persistedAtExit = "";
        runtime.exit.mockImplementation((code) => {
          persistedAtExit = existsSync(logFile) ? readFileSync(logFile, "utf8") : "";
          exit?.(code);
        });
        await runLoopWithStart({ start, runtime });
        await waitForStart(started);
        captureSignal("SIGUSR2")();
        await waitForLoopCondition(
          () => runtime.exit.mock.calls.length > 0 || flushLogger.mock.calls.length > 0,
          "close failure did not reach exit or log flush",
        );
        appendAllowed.resolve();
        await expect(exited).resolves.toBe(1);
        expect(persistedAtExit).toContain(
          "shutdown step failed (gateway server close): close owner failed",
        );
      });
    } finally {
      appendAllowed.resolve();
      await logger.flushLogger();
      logger.resetLogger();
      fileLogTransport.resetForTests();
      gatewayLog.error.mockReset();
      flushLogger.mockReset().mockResolvedValue(undefined);
    }
  });

  it("exits instead of reusing a failed lifecycle after managed restoration", async () => {
    consumeGatewayRestartIntent.mockReturnValueOnce({
      reason: "update.run",
      successorOwner: managedUpdateSuccessorOwner,
    });
    cancelManagedServiceUpdateHandoff
      .mockResolvedValueOnce("restart-after-exit")
      .mockResolvedValueOnce("restored-in-process");
    commitManagedServiceUpdateHandoff.mockResolvedValueOnce(false);
    await withIsolatedSignals(async ({ captureSignal }) => {
      const close = vi.fn<GatewayCloseFn>(async () => {
        throw new TypeError("close owner failed");
      });
      const { start, started } = createSignaledStart(close);
      const { runtime, exited } = createRuntimeWithExitSignal();
      await runLoopWithStart({ start, runtime });
      await waitForStart(started);
      const stop = captureSignal("SIGINT");
      try {
        captureSignal("SIGUSR2")();
        await waitForLoopCondition(
          () => runtime.exit.mock.calls.length > 0 || start.mock.calls.length > 1,
          "expected restart close failure to exit or start a new lifecycle",
        );
        expect(runtime.exit).toHaveBeenCalledWith(1);
        await expect(exited).resolves.toBe(1);
        expect(start).toHaveBeenCalledOnce();
        expect(gatewayLog.error).toHaveBeenCalledWith(
          "shutdown step failed (gateway server close): close owner failed",
        );
      } finally {
        if (runtime.exit.mock.calls.length === 0) {
          stop();
        }
        await exited;
      }
    });
  });

  it.each([{ signal: "SIGTERM", trace: "1" }] as const)(
    "reports only category counts while direct $signal stop is pending (trace=$trace)",
    async ({ signal, trace }) => {
      const traceEnv = captureEnv(["OPENCLAW_GATEWAY_RESTART_TRACE"]);
      process.env.OPENCLAW_GATEWAY_RESTART_TRACE = trace;
      try {
        await withIsolatedSignals(async ({ captureSignal }) => {
          const { close, runtime, exited } = await createSignaledLoopHarness();
          const cleanupSignal = gatewayWorkAdmissionActual.getGatewayShutdownCleanupSignal();
          close.mockImplementationOnce(async () => {
            expect(cleanupSignal.aborted).toBe(true);
          });
          const { startGatewayRestartTrace } = await import("../../gateway/restart-trace.js");
          startGatewayRestartTrace("prior.sequence");
          const pendingDrain = createDeferredCore();
          const enteredDrain = createDeferredCore();
          const activeSnapshot = createActiveWorkSnapshot(
            {
              queueSize: 1,
              pendingReplies: 2,
              embeddedRuns: 3,
              backgroundExecSessions: 4,
              cronRuns: 5,
              agentRuns: 6,
              acpRuns: 0,
              mediaRuns: 0,
              rootRequests: 7,
              sessionAdmissions: 8,
              sessionMutations: 9,
              chatRuns: 10,
              queuedTurns: 11,
              terminalPersistence: 12,
              terminalSessions: 13,
            },
            [
              { kind: "root-request", count: 7, message: "private-root-holder-origin" },
              {
                kind: "agent-run",
                count: 6,
                message: "private-task-message",
              },
            ],
          );
          const counts =
            "queueSize=1 pendingReplies=2 embeddedRuns=3 backgroundExecSessions=4 cronRuns=5 agentRuns=6 rootRequests=7 sessionAdmissions=8 sessionMutations=9 chatRuns=10 queuedTurns=11 terminalPersistence=12 terminalSessions=13";
          waitForGatewayActiveWork.mockImplementationOnce(async (_timeoutMs, options) => {
            options?.onSnapshot?.(activeSnapshot);
            enteredDrain.resolve();
            await pendingDrain.promise;
            return { drained: true, snapshot: idleActiveWorkSnapshot };
          });
          let now = Date.now();
          const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
          try {
            captureSignal(signal)();
            await enteredDrain.promise;
            expect(gatewayWorkAdmissionActual.isGatewayWorkAdmissionClosed()).toBe(true);
            expect(waitForGatewayActiveWork).toHaveBeenCalledWith(315_000, {
              onSnapshot: expect.any(Function),
            });
            expect(createGatewayActiveWorkSnapshot).not.toHaveBeenCalled();
            expect(close).not.toHaveBeenCalled();
            expect(cleanupSignal.aborted).toBe(false);
            expect(runtime.exit).not.toHaveBeenCalled();
            expect(gatewayLog.info).toHaveBeenCalledWith(
              `draining active work before stop with timeout 315000ms: ${counts}`,
            );
            captureSignal(signal)();
            expect(waitForGatewayActiveWork).toHaveBeenCalledOnce();
            const onSnapshot = waitForGatewayActiveWork.mock.calls[0]?.[1]?.onSnapshot;
            now += 29_999;
            onSnapshot?.(activeSnapshot);
            expect(gatewayLog.warn).not.toHaveBeenCalled();
            now += 1;
            onSnapshot?.(activeSnapshot);
            onSnapshot?.(activeSnapshot);
            expect(gatewayLog.warn).toHaveBeenCalledExactlyOnceWith(
              `still draining active work before stop: ${counts}`,
            );
            clock.mockRestore();
            pendingDrain.resolve();
            await expect(exited).resolves.toBe(0);
            expect(abortEmbeddedAgentRun).not.toHaveBeenCalled();
            expect(gatewayLog.info).toHaveBeenCalledWith(
              "active-work drain settled; beginning server close",
            );
            const output = [...gatewayLog.info.mock.calls, ...gatewayLog.warn.mock.calls]
              .flat()
              .join("\n");
            expect(output).not.toContain("private-");
            expect(output).not.toContain("totalActive");
            expect(output.includes("restart trace:")).toBe(trace === "1");
            const starts = gatewayLog.info.mock.calls
              .flat()
              .filter((line) => String(line).includes("stop.signal.received "));
            expect(starts).toEqual(
              trace === "1"
                ? [`restart trace: stop.signal.received 0.0ms total=0.0ms signal=${signal}`]
                : [],
            );
            expect(close).toHaveBeenCalledWith({
              reason: "gateway stopping",
              restartExpectedMs: null,
            });
          } finally {
            clock.mockRestore();
            pendingDrain.resolve();
            await exited;
          }
        });
      } finally {
        traceEnv.restore();
      }
    },
  );

  registerShutdownBudgetTests(fixtures);

  registerShutdownCompletionTests(fixtures);

  registerGatewayRestartOwnershipTests(fixtures);

  it("restarts after SIGUSR2 even when drain times out, and resets runtime state for the new iteration", async () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    markUpdateRestartSentinelFailure.mockClear();
    const firstCronDrain = createDeferredCore<{ drained: boolean; active: number }>();
    waitForActiveCronTaskRuns.mockImplementationOnce(() => firstCronDrain.promise);

    await withIsolatedSignals(async ({ captureSignal }) => {
      const timedOutSnapshot = createActiveWorkSnapshot({ agentRuns: 2, embeddedRuns: 1 }, [
        { kind: "agent-run", count: 2, message: "2 active background task run(s)" },
        { kind: "embedded-run", count: 1, message: "1 active embedded run(s)" },
      ]);
      createGatewayActiveWorkSnapshot
        .mockReturnValueOnce(timedOutSnapshot)
        .mockReturnValue(idleActiveWorkSnapshot);
      waitForGatewayActiveWork.mockResolvedValueOnce({
        drained: false,
        snapshot: timedOutSnapshot,
      });

      const closeFirst = createCloseMock();
      const closeSecond = createCloseMock();
      const closeThird = createCloseMock();
      const { runtime, exited } = createRuntimeWithExitSignal();
      const lifecycleSlot = resolveGlobalMap<string, number>(
        Symbol("run-loop-lifecycle-slot"),
        (state) => state.clear(),
      );
      const agentEventsActual = await vi.importActual<typeof import("../../infra/agent-events.js")>(
        "../../infra/agent-events.js",
      );
      const firstAgentEventGeneration = agentEventsActual.getAgentEventLifecycleGeneration();

      const { start, started: startedFirst } = createSignaledStart(closeFirst);
      const startedSecond = createDeferredCore();
      const startedThird = createDeferredCore();
      // Only the first start uses createSignaledStart's default implementation.
      start.mockImplementationOnce(start.getMockImplementation()!);
      let secondAgentEventGeneration: string | undefined;
      let secondRestartDrainSignal: AbortSignal | undefined;
      start.mockImplementationOnce(async () => {
        expect(lifecycleSlot.size).toBe(0);
        secondAgentEventGeneration = agentEventsActual.getAgentEventLifecycleGeneration();
        secondRestartDrainSignal = gatewayWorkAdmissionActual.getGatewayRestartDrainSignal();
        expect(secondRestartDrainSignal.aborted).toBe(false);
        lifecycleSlot.set("second", 2);
        startedSecond.resolve();
        return createGatewayServer(closeSecond);
      });

      start.mockImplementationOnce(async () => {
        expect(lifecycleSlot.size).toBe(0);
        startedThird.resolve();
        return createGatewayServer(closeThird);
      });

      const { runGatewayLoop } = await import("./run-loop.js");
      void runGatewayLoop({ start, runtime });

      await startedFirst;
      lifecycleSlot.set("first", 1);
      const restartSignal = captureSignal("SIGUSR2");
      const sigterm = captureSignal("SIGTERM");
      expect(start).toHaveBeenCalledTimes(1);
      await waitForLoopTurn();

      restartSignal();

      await waitForLoopCondition(
        () => waitForActiveCronTaskRuns.mock.calls.length === 1,
        "expected first restart to reach cron task drain",
      );
      restartSignal();
      firstCronDrain.resolve({ drained: true, active: 0 });
      await startedSecond.promise;
      expect(secondAgentEventGeneration).not.toBe(firstAgentEventGeneration);

      expect(waitForGatewayActiveWork.mock.calls[0]?.[0]).toBeLessThanOrEqual(
        DEFAULT_RESTART_DEFERRAL_TIMEOUT_MS,
      );
      expect(gatewayLog.warn).toHaveBeenCalledWith(
        "restart drain budget 300000ms exhausted; cutting short embeddedRuns=1 agentRuns=2",
      );
      expectRestartCloseCall(closeFirst, DEFAULT_RESTART_DEFERRAL_TIMEOUT_MS);
      await startedThird.promise;
      expect(secondRestartDrainSignal?.aborted).toBe(true);
      const thirdAgentEventGeneration = agentEventsActual.getAgentEventLifecycleGeneration();
      expect(thirdAgentEventGeneration).not.toBe(secondAgentEventGeneration);
      expect(gatewayWorkAdmissionActual.isGatewayWorkAdmissionClosed()).toBe(false);
      await waitForLoopTurn();
      expectRestartCloseCall(closeSecond, DEFAULT_RESTART_DEFERRAL_TIMEOUT_MS);
      expect(markGatewayRestartHandled).toHaveBeenCalledTimes(2);
      expect(abortActiveCronTaskRuns).toHaveBeenCalledTimes(3);
      expect(waitForActiveCronTaskRuns).toHaveBeenCalledTimes(2);
      expect(waitForActiveCronJobs).toHaveBeenCalledTimes(2);
      expect(advanceCronActiveJobGeneration).toHaveBeenCalledTimes(2);
      expect(retireActiveCronTaskRunTracking).toHaveBeenCalledTimes(2);
      expect(resetCronActiveJobs).toHaveBeenCalledTimes(2);
      expect(clearRuntimeConfigSnapshot).toHaveBeenCalledTimes(2);
      expect(resetGatewaySuspendCoordinatorForLifecycleRestart).toHaveBeenCalledTimes(2);
      expect(resetGatewayRestartStateForInProcessRestart).toHaveBeenCalledTimes(2);
      expect(acquireGatewayLock).toHaveBeenCalledTimes(3);
      expect(advanceCronActiveJobGeneration.mock.invocationCallOrder[0] ?? Infinity).toBeLessThan(
        abortActiveCronTaskRuns.mock.invocationCallOrder[1] ?? Infinity,
      );
      expect(abortActiveCronTaskRuns.mock.invocationCallOrder[0] ?? Infinity).toBeLessThan(
        closeFirst.mock.invocationCallOrder[0] ?? Infinity,
      );
      expect(waitForActiveCronJobs.mock.invocationCallOrder[0] ?? Infinity).toBeLessThan(
        retireActiveCronTaskRunTracking.mock.invocationCallOrder[0] ?? Infinity,
      );
      expect(retireActiveCronTaskRunTracking.mock.invocationCallOrder[0] ?? Infinity).toBeLessThan(
        resetCronActiveJobs.mock.invocationCallOrder[0] ?? Infinity,
      );

      sigterm();
      await expect(exited).resolves.toBe(0);
      expect(closeThird).toHaveBeenCalledWith({
        reason: "gateway stopping",
        restartExpectedMs: null,
      });
    }).finally(() => clock.mockRestore());
  });

  it("advances stale cron active markers after bounded restart cron-run drain", async () => {
    waitForActiveCronJobs.mockResolvedValueOnce({ drained: false, active: 1 });

    await withIsolatedSignals(async ({ captureSignal }) => {
      const { start, exited } = await createSignaledLoopHarness();
      const restartSignal = captureSignal("SIGUSR2");
      const sigint = captureSignal("SIGINT");

      restartSignal();
      await waitForLoopCondition(
        () => start.mock.calls.length >= 2,
        "expected SIGUSR2 to trigger restart",
      );

      expect(abortActiveCronTaskRuns).toHaveBeenCalledWith("Gateway restarting.");
      expect(waitForActiveCronTaskRuns).toHaveBeenCalledWith(1_000);
      expect(waitForActiveCronJobs).toHaveBeenCalledWith(1_000);
      expect(advanceCronActiveJobGeneration).toHaveBeenCalledTimes(1);
      expect(retireActiveCronTaskRunTracking).toHaveBeenCalledTimes(1);
      expect(resetCronActiveJobs).toHaveBeenCalledTimes(1);
      expect(gatewayLog.warn).toHaveBeenCalledWith(
        "cron run drain timed out during restart lifecycle reset after retiring old cron admission; 0 task handle(s) and 1 active marker(s) remain after aborting old cron runs",
      );

      sigint();
      await expect(exited).resolves.toBe(0);
    });
  });

  it.each([false, true])(
    "processes SIGUSR2 queued before startup returns a server (startup fails: %s)",
    async (fails) => {
      await withIsolatedSignals(async ({ captureSignal }) => {
        const firstClose = createCloseMock();
        const { runtime, exited } = createRuntimeWithExitSignal();
        const enterStartup = createDeferredCore();
        const startedReplacement = createDeferredCore();
        const start =
          vi.fn<Parameters<typeof import("./run-loop.js").runGatewayLoop>[0]["start"]>();
        if (fails) {
          start.mockResolvedValueOnce(createGatewayServer(firstClose));
        }
        start.mockImplementationOnce(async () => {
          await enterStartup.promise;
          captureSignal("SIGUSR2")();
          await waitForLoopCondition(
            () => markGatewayRestartHandled.mock.calls.length === (fails ? 2 : 1),
            "expected queued SIGUSR2 before startup settled",
          );
          expect(gatewayWorkAdmissionActual.isGatewayWorkAdmissionClosed()).toBe(true);
          if (fails) {
            throw new Error("restart startup failed");
          }
          return createGatewayServer(firstClose);
        });
        start.mockImplementationOnce(async () => {
          startedReplacement.resolve();
          return createGatewayServer(createCloseMock());
        });
        const { runGatewayLoop } = await import("./run-loop.js");
        void runGatewayLoop({ start, runtime });
        await waitForLoopTurn();
        const sigterm = captureSignal("SIGTERM");
        try {
          if (fails) {
            captureSignal("SIGUSR2")();
          }
          enterStartup.resolve();
          await startedReplacement.promise;
          expect(start).toHaveBeenCalledTimes(fails ? 3 : 2);
          expectRestartCloseCall(firstClose, DEFAULT_RESTART_DEFERRAL_TIMEOUT_MS);
          expect(markGatewayRestartHandled).toHaveBeenCalledTimes(fails ? 2 : 1);
          expect(gatewayWorkAdmissionActual.isGatewayWorkAdmissionClosed()).toBe(false);
          expect(resetGatewaySuspendCoordinatorForLifecycleRestart).toHaveBeenCalledTimes(
            fails ? 2 : 1,
          );
          expect(resetGatewayRestartStateForInProcessRestart).toHaveBeenCalledTimes(fails ? 2 : 1);
          expect(acquireGatewayLock).toHaveBeenCalledTimes(fails ? 3 : 2);
          if (fails) {
            expect(gatewayLog.error).toHaveBeenCalledWith(
              expect.stringContaining("gateway startup failed: restart startup failed."),
            );
          }
        } finally {
          enterStartup.resolve();
          sigterm();
          await expect(exited).resolves.toBe(0);
        }
      });
    },
  );

  it("expires a queued startup restart using the refreshed budget after an update upgrade", async () => {
    peekGatewayRestartReason.mockReturnValue(undefined);
    process.env.OPENCLAW_SYSTEMD_UNIT = "openclaw-gateway.service";
    setPlatform("linux");
    systemctl.mockResolvedValue({
      code: 0,
      stdout: "LoadState=loaded\nTimeoutStopUSec=30s",
      stderr: "",
    });
    vi.useFakeTimers();
    const clock = vi.spyOn(performance, "now").mockImplementation(() => Date.now());

    try {
      await withIsolatedSignals(async ({ captureSignal }) => {
        const close = vi.fn(async () => {});
        const startupNeverReturns = new Promise<void>(() => {});
        const startupEntered = createDeferredCore();
        const { runtime, exited } = createRuntimeWithExitSignal();
        const completeBoot = vi.fn();
        const start = vi.fn(async () => {
          startupEntered.resolve();
          await startupNeverReturns;
          return createGatewayServer(close);
        });

        const { runGatewayLoop } = await import("./run-loop.js");
        void runGatewayLoop({
          start,
          runtime,
          completeBoot,
        });
        await vi.advanceTimersByTimeAsync(0);
        await startupEntered.promise;
        const restartSignal = captureSignal("SIGUSR2");

        const refreshed = {
          code: 0,
          stdout: "LoadState=loaded\nTimeoutStopUSec=330s",
          stderr: "",
        };
        systemctl.mockResolvedValue(refreshed);
        const query = createDeferredCore<typeof refreshed>();
        systemctl.mockImplementationOnce(() => query.promise);
        restartSignal();
        await vi.advanceTimersByTimeAsync(0);
        peekGatewayRestartReason.mockReturnValue("update.run");
        consumeGatewayRestartIntent.mockReturnValueOnce({ reason: "update.run", force: true });
        restartSignal();
        await vi.advanceTimersByTimeAsync(0);
        expect(gatewayLog.info).toHaveBeenCalledWith(
          "received SIGUSR2 during shutdown; upgrading to update.run",
        );
        query.resolve(refreshed);
        await vi.advanceTimersByTimeAsync(0);
        expect(markGatewayRestartHandled).toHaveBeenCalledTimes(2);
        expect(gatewayWorkAdmissionActual.isGatewayWorkAdmissionClosed()).toBe(true);
        expect(runtime.exit).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(324_999);
        expect(runtime.exit).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);

        await expect(exited).resolves.toBe(1);
        expect(completeBoot).toHaveBeenCalledWith({
          outcome: "forced_stop",
          reason: "gateway.restart_startup_request_timeout",
        });
        expect(close).not.toHaveBeenCalled();
        expect(start).toHaveBeenCalledTimes(1);
        expect(gatewayLog.error).toHaveBeenCalledWith(
          "startup restart request timed out before gateway returned a close handle; exiting for supervisor recovery",
        );
      });
    } finally {
      clock.mockRestore();
      vi.useRealTimers();
    }
  });

  it.each(["restart-then-stop", "cleanup-failure", "repaired-systemd"] as const)(
    "joins admitted startup cleanup for %s before exiting",
    async (scenario) => {
      if (scenario === "repaired-systemd") {
        process.env.OPENCLAW_SYSTEMD_UNIT = "openclaw-gateway.service";
        systemctl.mockResolvedValue({
          code: 0,
          stdout: "LoadState=loaded\nTimeoutStopUSec=30s",
          stderr: "",
        });
      }
      await withIsolatedSignals(async ({ captureSignal }) => {
        const entered = createDeferredCore<AbortSignal>();
        const cleanup = createDeferredCore();
        const activeDrain = createDeferredCore();
        waitForGatewayActiveWork.mockImplementationOnce(async () => {
          await activeDrain.promise;
          return { drained: true, snapshot: idleActiveWorkSnapshot };
        });
        const cleanupFailure = new Error("startup snapshot cleanup failed");
        const completeBoot = vi.fn();
        const close = createCloseMock();
        const { runtime, exited } = createRuntimeWithExitSignal();
        const { runGatewayLoop } = await import("./run-loop.js");
        const start: Parameters<typeof runGatewayLoop>[0]["start"] = async (options) => {
          await options!.startupOperation!(async (signal) => {
            entered.resolve(signal);
            await new Promise<void>((resolve) => {
              signal.addEventListener("abort", () => resolve(), { once: true });
            });
            await cleanup.promise;
            throw scenario === "cleanup-failure" ? cleanupFailure : signal.reason;
          });
          return createGatewayServer(close);
        };
        const loop = runGatewayLoop({ start, runtime, completeBoot });
        const settled = Promise.allSettled([loop]);
        let loopFinished = false;
        void settled.then(() => {
          loopFinished = true;
        });
        const signal = await entered.promise;
        const stopSignal = scenario === "repaired-systemd" ? "SIGTERM" : "SIGINT";
        if (scenario === "repaired-systemd") {
          systemctl.mockResolvedValue({
            code: 0,
            stdout: "LoadState=loaded\nTimeoutStopUSec=330s",
            stderr: "",
          });
          vi.useFakeTimers();
        }
        const flush = async () => {
          if (scenario === "repaired-systemd") {
            await vi.advanceTimersByTimeAsync(0);
          } else {
            await waitForLoopTurn();
          }
        };
        try {
          if (scenario === "restart-then-stop") {
            captureSignal("SIGUSR2")();
            await waitForLoopCondition(
              () => markGatewayRestartHandled.mock.calls.length > 0,
              "expected queued startup restart",
            );
            expect(signal.aborted).toBe(false);
          }
          captureSignal(stopSignal)();
          await flush();
          expect(signal.aborted).toBe(true);
          // A duplicate signal cannot bypass the already admitted cleanup join.
          captureSignal(stopSignal)();
          if (scenario === "repaired-systemd") {
            await vi.advanceTimersByTimeAsync(60_000);
          }
          await flush();
          expect(runtime.exit).not.toHaveBeenCalled();
          expect(completeBoot).not.toHaveBeenCalled();
          cleanup.resolve();
          await flush();
          expect(loopFinished).toBe(false);
          expect(runtime.exit).not.toHaveBeenCalled();
          expect(completeBoot).not.toHaveBeenCalled();
          activeDrain.resolve();
          await flush();
          await expect(exited).resolves.toBe(scenario === "cleanup-failure" ? 1 : 0);
          if (scenario === "cleanup-failure") {
            expect(await settled).toEqual([{ status: "rejected", reason: cleanupFailure }]);
            expect(completeBoot).toHaveBeenCalledExactlyOnceWith({
              outcome: "forced_stop",
              reason: "gateway.stop_close_failed",
            });
          } else {
            expect(await settled).toEqual([{ status: "fulfilled", value: undefined }]);
            expect(completeBoot).toHaveBeenCalledExactlyOnceWith({
              outcome: "clean_stop",
              reason: `stop (${stopSignal})`,
            });
          }
          expect(close).not.toHaveBeenCalled();
        } finally {
          if (!signal.aborted) {
            captureSignal("SIGINT")();
          }
          cleanup.resolve();
          activeDrain.resolve();
          await flush();
          await settled;
          vi.useRealTimers();
        }
      });
    },
  );

  it.each([
    { stop: true, signal: "SIGTERM", cleanStop: true },
    { stop: true, signal: "SIGKILL", cleanStop: false },
  ] as const)(
    "joins an accepted stop before classifying an independent startup worker: $stop / $signal",
    async ({ stop, signal, cleanStop }) => {
      const { SqliteIntegrityWorkerInterruptedError } =
        await import("../../infra/sqlite-integrity-worker-error.js");
      await withIsolatedSignals(async ({ captureSignal }) => {
        const entered = createDeferredCore();
        const inspection = createDeferredCore();
        const drainEntered = createDeferredCore();
        const drain = createDeferredCore();
        waitForGatewayActiveWork.mockImplementationOnce(async () => {
          drainEntered.resolve();
          await drain.promise;
          return { drained: true, snapshot: idleActiveWorkSnapshot };
        });
        const failure = new SqliteIntegrityWorkerInterruptedError(signal, "starting");
        const completeBoot = vi.fn();
        const close = createCloseMock();
        const { runtime, exited } = createRuntimeWithExitSignal();
        const { runGatewayLoop } = await import("./run-loop.js");
        const loop = runGatewayLoop({
          start: async () => {
            entered.resolve();
            await inspection.promise;
            return createGatewayServer(close);
          },
          runtime,
          completeBoot,
        });
        const settled = Promise.allSettled([loop]);
        try {
          await entered.promise;
          if (stop) {
            captureSignal("SIGTERM")();
            await drainEntered.promise;
          }
          inspection.reject(failure);
          await waitForLoopTurn();
          expect(runtime.exit).not.toHaveBeenCalled();
          if (cleanStop) {
            expect(completeBoot).not.toHaveBeenCalled();
          }
          drain.resolve();
          if (cleanStop) {
            await expect(exited).resolves.toBe(0);
            expect(await settled).toEqual([{ status: "fulfilled", value: undefined }]);
            expect(completeBoot).toHaveBeenCalledExactlyOnceWith({
              outcome: "clean_stop",
              reason: "stop (SIGTERM)",
            });
          } else {
            expect(await settled).toEqual([{ status: "rejected", reason: failure }]);
            expect(completeBoot).toHaveBeenCalledWith({
              outcome: "startup_failed",
              reason: failure.message,
            });
          }
          expect(close).not.toHaveBeenCalled();
        } finally {
          inspection.reject(failure);
          drain.resolve();
          await settled;
          if (stop) {
            await exited;
          }
        }
      });
    },
  );

  it.each(["stopped", "started"] as const)(
    "refuses retained startup work after %s",
    async (phase) => {
      await withIsolatedSignals(async ({ captureSignal }) => {
        const entered = createDeferredCore<GatewayStartupOperation>();
        const resumeStartup = createDeferredCore();
        const close = createCloseMock();
        const acquireResource = vi.fn(async () => {});
        const { runtime, exited } = createRuntimeWithExitSignal();
        const { runGatewayLoop } = await import("./run-loop.js");
        const start: Parameters<typeof runGatewayLoop>[0]["start"] = async (options) => {
          entered.resolve(options!.startupOperation!);
          if (phase === "stopped") {
            await resumeStartup.promise;
            await options!.startupOperation!(acquireResource);
          }
          return createGatewayServer(close);
        };
        const loop = runGatewayLoop({ start, runtime });
        const observed = loop.catch(() => {});
        const startupOperation = await entered.promise;
        try {
          if (phase === "stopped") {
            captureSignal("SIGINT")();
            await exited;
          } else {
            await waitForLoopTurn();
          }
          await expect(startupOperation(acquireResource)).rejects.toMatchObject({
            name: "AbortError",
          });
          expect(acquireResource).not.toHaveBeenCalled();
        } finally {
          resumeStartup.resolve();
          if (phase === "started") {
            captureSignal("SIGINT")();
            await exited;
          } else {
            await observed;
          }
        }
      });
    },
  );

  it.each([true, false])(
    "clears the SIGUSR2 token before applying external restart policy (allowed: %s)",
    async (allowed) => {
      consumeGatewayRestartAuthorization.mockReturnValueOnce(false);
      isGatewayRestartExternallyAllowed.mockReturnValueOnce(allowed);
      await withIsolatedSignals(async ({ captureSignal }) => {
        const { close, start } = await createSignaledLoopHarness();
        const restartDrainSignal = gatewayWorkAdmissionActual.getGatewayRestartDrainSignal();
        captureSignal("SIGUSR2")();
        await waitForLoopTurn();
        expect(markGatewayRestartHandled).toHaveBeenCalledOnce();
        expect(close).not.toHaveBeenCalled();
        expect(start).toHaveBeenCalledOnce();
        if (allowed) {
          expect(scheduleGatewayRestart).toHaveBeenCalledWith({ delayMs: 0, reason: "SIGUSR2" });
          expect(markGatewayRestartHandled.mock.invocationCallOrder[0]).toBeLessThan(
            scheduleGatewayRestart.mock.invocationCallOrder[0] ?? 0,
          );
        } else {
          expect(scheduleGatewayRestart).not.toHaveBeenCalled();
          expect(restartDrainSignal.aborted).toBe(false);
          expect(gatewayWorkAdmissionActual.isGatewayRestartDraining()).toBe(false);
          expect(gatewayLog.warn.mock.calls).toEqual([
            ["SIGUSR2 restart ignored (not authorized; commands.restart=false)."],
            [
              "An unauthorized SIGUSR2 restart signal was received and ignored. " +
                "If a pending gateway restart needs to be applied, run `openclaw gateway restart` " +
                "or restart the gateway through your service manager.",
            ],
          ]);
        }
      });
    },
  );

  it.each([true, false])(
    "consumes file-intent SIGUSR2 and cancels pending reloads (authorized=%s)",
    async (authorized) => {
      consumeGatewayRestartIntentPayloadSync.mockReturnValueOnce({
        force: true,
        reason: "file-intent restart",
      });
      consumeGatewayRestartAuthorization.mockReturnValueOnce(authorized);
      createGatewayActiveWorkSnapshot.mockReturnValue(
        createActiveWorkSnapshot({ embeddedRuns: 1 }, [
          { kind: "embedded-run", count: 1, message: "1 active embedded run(s)" },
        ]),
      );

      await withIsolatedSignals(async ({ captureSignal }) => {
        const { start, exited } = await createSignaledLoopHarness();
        captureSignal("SIGUSR2")();
        await waitForLoopTurn();
        await waitForLoopTurn();

        expect(abortPendingChannelReloads).toHaveBeenCalledOnce();
        expect(consumeGatewayRestartAuthorization).toHaveBeenCalledOnce();
        expect(markGatewayRestartHandled).toHaveBeenCalledTimes(authorized ? 1 : 0);
        expect(start).toHaveBeenCalledTimes(2);

        captureSignal("SIGINT")();
        await expect(exited).resolves.toBe(0);
      });
    },
  );

  it.each([{ marker: "OPENCLAW_WINDOWS_TASK_NAME", value: "OpenClaw Gateway", exitCode: 75 }])(
    "releases the lock before supervised restart exit $exitCode",
    async ({ marker, value, exitCode }) => {
      peekGatewayRestartReason.mockReturnValue(undefined);
      const env = captureEnv([marker, "OPENCLAW_GATEWAY_RESTART_TRACE"]);
      process.env[marker] = value;
      process.env.OPENCLAW_GATEWAY_RESTART_TRACE = "1";
      try {
        await withIsolatedSignals(async ({ captureSignal }) => {
          const exitCallOrder: string[] = [];
          const lockRelease = vi.fn(async () => {
            exitCallOrder.push("lockRelease");
          });
          acquireGatewayLock.mockResolvedValueOnce({ release: lockRelease });
          restartGatewayProcessWithFreshPid.mockReturnValueOnce({ mode: "supervised", exitCode });
          const { runtime, exited } = await createSignaledLoopHarness(exitCallOrder);
          captureSignal("SIGUSR2")();

          await expect(exited).resolves.toBe(exitCode ?? 0);
          expect(lockRelease).toHaveBeenCalledOnce();
          expect(runtime.exit).toHaveBeenCalledWith(exitCode ?? 0);
          expect(exitCallOrder).toEqual(["lockRelease", "exit"]);
          const [respawnOpts] = restartGatewayProcessWithFreshPid.mock.calls[0] ?? [];
          expect(respawnOpts?.env?.OPENCLAW_GATEWAY_RESTART_TRACE_STARTED_AT_MS).toMatch(/^\d/u);
          expect(respawnOpts?.env?.OPENCLAW_GATEWAY_RESTART_TRACE_LAST_AT_MS).toMatch(/^\d/u);
          expect(writeGatewayRestartHandoffSync).toHaveBeenCalledOnce();
        });
      } finally {
        env.restore();
      }
    },
  );

  it("exits when lock reacquire fails during in-process restart fallback", async () => {
    peekGatewayRestartReason.mockReturnValue(undefined);

    await withIsolatedSignals(async ({ captureSignal }) => {
      const lockRelease = vi.fn(async () => {});
      acquireGatewayLock
        .mockResolvedValueOnce({
          release: lockRelease,
        })
        .mockRejectedValueOnce(new Error("lock timeout"));

      restartGatewayProcessWithFreshPid.mockReturnValueOnce({
        mode: "disabled",
      });

      const { start, exited } = await createSignaledLoopHarness();
      const restartSignal = captureSignal("SIGUSR2");
      restartSignal();

      await expect(exited).resolves.toBe(1);
      expect(acquireGatewayLock).toHaveBeenCalledTimes(2);
      expect(start).toHaveBeenCalledTimes(1);
      expect(gatewayLog.error).toHaveBeenCalledWith(
        "failed to reacquire gateway lock for in-process restart: Error: lock timeout",
      );
    });
  });

  registerUpdateRespawnProgressTests(fixtures);

  registerUpdateRespawnTests(fixtures);

  it("keeps SIGTERM restart ownership when an update arrives during shutdown", async () => {
    consumeGatewayRestartIntentPayloadSync.mockReturnValueOnce({ reason: "gateway.restart" });
    peekGatewayRestartReason.mockReturnValueOnce("update.run");
    const closing = createDeferred();
    const close = vi.fn<GatewayCloseFn>(() => closing.promise);

    await withIsolatedSignals(async ({ captureSignal }) => {
      const { start, started } = createSignaledStart(close);
      const { runtime, exited } = createRuntimeWithExitSignal();
      const completeBoot = vi.fn();
      await runLoopWithStart({ start, runtime, completeBoot });
      await waitForStart(started);
      try {
        captureSignal("SIGTERM")();
        await waitForLoopCondition(() => close.mock.calls.length === 1, "close did not start");
        captureSignal("SIGUSR2")();
        await waitForLoopCondition(
          () => markGatewayRestartHandled.mock.calls.length === 1,
          "update signal was not handled",
        );
        closing.resolve();
        await waitForLoopCondition(
          () => runtime.exit.mock.calls.length > 0 || start.mock.calls.length > 1,
          "SIGTERM restart did not finish",
        );
        expect(start).toHaveBeenCalledOnce();
        await expect(exited).resolves.toBe(0);
        expect(completeBoot).toHaveBeenCalledWith({
          outcome: "planned_restart",
          reason: "restart (SIGTERM: gateway.restart)",
        });
        expect(restartGatewayProcessWithFreshPid).not.toHaveBeenCalled();
        expect(respawnGatewayProcessForUpdate).not.toHaveBeenCalled();
      } finally {
        closing.resolve();
      }
    });
  });

  it.each(["close", "lock release"] as const)(
    "upgrades an accepted restart when an update arrives during %s",
    async (phase) => {
      peekGatewayRestartReason
        .mockReturnValueOnce("config.patch")
        .mockReturnValueOnce("update.auto");
      restartGatewayProcessWithFreshPid.mockReturnValueOnce({ mode: "supervised" });
      const blocked = createDeferredCore();
      const entered = createDeferredCore();
      const pause = async () => {
        entered.resolve();
        await blocked.promise;
      };
      if (phase === "close") {
        setPlatform("freebsd");
      } else {
        acquireGatewayLock.mockResolvedValueOnce({ release: vi.fn(pause) });
      }
      process.env.OPENCLAW_SUPERVISOR_MODE = "external";
      try {
        await withIsolatedSignals(async ({ captureSignal }) => {
          const { close, exited } = await createSignaledLoopHarness(undefined, phase === "close");
          if (phase === "close") {
            close.mockImplementationOnce(pause);
          }
          captureSignal("SIGUSR2")();
          await entered.promise;
          captureSignal("SIGUSR2")();
          await waitForLoopCondition(
            () => markGatewayRestartHandled.mock.calls.length === 2,
            "second restart signal was not handled",
          );
          blocked.resolve();
          await expect(exited).resolves.toBe(0);
          expect(restartGatewayProcessWithFreshPid).toHaveBeenCalledOnce();
          expectRestartHandoffCall({
            restartKind: "update-process",
            reason: "update.auto",
            supervisorMode: "external",
          });
        });
      } finally {
        blocked.resolve();
        delete process.env.OPENCLAW_SUPERVISOR_MODE;
      }
    },
  );

  it("recovers in process after exactly cancelling a replacement managed owner before exit", async () => {
    const replacementOwner = { ...managedUpdateSuccessorOwner, handoffId: "replacement-handoff" };
    consumeGatewayRestartIntent
      .mockReturnValueOnce({ reason: "update.run", successorOwner: managedUpdateSuccessorOwner })
      .mockReturnValueOnce({ reason: "update.auto", successorOwner: replacementOwner });
    cancelManagedServiceUpdateHandoff
      .mockResolvedValueOnce("restored-in-process")
      .mockResolvedValueOnce("restored-in-process");

    const commitBlocked = createDeferredCore();
    commitManagedServiceUpdateHandoff.mockImplementationOnce(async () => {
      await commitBlocked.promise;
      return true;
    });
    setPlatform("linux");
    process.env.OPENCLAW_SERVICE_MARKER = "openclaw";
    process.env.OPENCLAW_SERVICE_KIND = "gateway";
    try {
      await withIsolatedSignals(async ({ captureSignal }) => {
        const { start, runtime, exited } = await createSignaledLoopHarness();
        const restartSignal = captureSignal("SIGUSR2");
        const sigint = captureSignal("SIGINT");
        restartSignal();
        await waitForLoopCondition(
          () => commitManagedServiceUpdateHandoff.mock.calls.length === 1,
          "managed owner did not reach its final helper commit",
        );
        restartSignal();
        await waitForLoopCondition(
          () => consumeGatewayRestartIntent.mock.calls.length === 2,
          "replacement owner was not admitted before exit",
        );
        commitBlocked.resolve();
        await waitForLoopCondition(
          () => start.mock.calls.length === 2,
          "replacement managed owner cancellation did not reopen gateway admission",
        );

        expect(requestManagedServiceUpdateHandoffPark).toHaveBeenCalledExactlyOnceWith(
          managedUpdateSuccessorOwner,
        );
        expect(cancelManagedServiceUpdateHandoff).toHaveBeenNthCalledWith(
          1,
          managedUpdateSuccessorOwner,
        );
        expect(cancelManagedServiceUpdateHandoff).toHaveBeenNthCalledWith(2, replacementOwner);
        expect(commitManagedServiceUpdateHandoff).toHaveBeenCalledExactlyOnceWith(
          managedUpdateSuccessorOwner,
          "update",
        );
        expect(runtime.exit).not.toHaveBeenCalled();
        expect(start).toHaveBeenCalledTimes(2);
        expect(gatewayWorkAdmissionActual.isGatewayWorkAdmissionClosed()).toBe(false);

        sigint();
        await expect(exited).resolves.toBe(0);
      });
    } finally {
      commitBlocked.resolve();
      delete process.env.OPENCLAW_SERVICE_MARKER;
      delete process.env.OPENCLAW_SERVICE_KIND;
    }
  });

  it("reopens admission after a broken control pipe waits for the exact helper to exit", async () => {
    consumeGatewayRestartIntent.mockReturnValueOnce({
      reason: "update.run",
      successorOwner: managedUpdateSuccessorOwner,
    });
    requestManagedServiceUpdateHandoffPark.mockResolvedValueOnce(false);
    const helperExit = createDeferredCore();
    cancelManagedServiceUpdateHandoff.mockImplementationOnce(async () => {
      await helperExit.promise;
      return "restored-in-process";
    });
    setPlatform("linux");
    process.env.OPENCLAW_SERVICE_MARKER = "openclaw";
    process.env.OPENCLAW_SERVICE_KIND = "gateway";

    try {
      await withIsolatedSignals(async ({ captureSignal }) => {
        const { start, runtime, exited } = await createSignaledLoopHarness();
        const restartSignal = captureSignal("SIGUSR2");
        const sigint = captureSignal("SIGINT");

        restartSignal();
        await waitForLoopCondition(
          () => cancelManagedServiceUpdateHandoff.mock.calls.length === 1,
          "broken helper control pipe did not begin exact-owner cancellation",
        );
        expect(start).toHaveBeenCalledOnce();
        expect(gatewayWorkAdmissionActual.isGatewayWorkAdmissionClosed()).toBe(true);
        helperExit.resolve();
        await waitForLoopCondition(
          () => start.mock.calls.length === 2,
          "broken helper control pipe left the gateway permanently draining",
        );

        expect(cancelManagedServiceUpdateHandoff).toHaveBeenCalledExactlyOnceWith(
          managedUpdateSuccessorOwner,
        );
        expect(commitManagedServiceUpdateHandoff).not.toHaveBeenCalled();
        expect(runtime.exit).not.toHaveBeenCalled();
        expect(gatewayWorkAdmissionActual.isGatewayWorkAdmissionClosed()).toBe(false);

        sigint();
        await expect(exited).resolves.toBe(0);
      });
    } finally {
      helperExit.resolve();
      delete process.env.OPENCLAW_SERVICE_MARKER;
      delete process.env.OPENCLAW_SERVICE_KIND;
    }
  });

  it("recovers a dead update child when readiness reports it stopped", async () => {
    peekGatewayRestartReason.mockReturnValue("update.run");
    const kill = vi.fn();
    respawnGatewayProcessForUpdate.mockReturnValueOnce({
      mode: "spawned",
      pid: 8888,
      child: Object.assign(createUpdateRespawnChild(8888), { kill, exitCode: 1 }),
    });

    await withIsolatedSignals(async ({ captureSignal }) => {
      waitForGatewayHealthyRestart.mockResolvedValueOnce(
        respawnHealth({
          healthy: false,
          waitOutcome: "stopped-free",
          runtime: { status: "stopped" },
        }),
      );
      const closeFirst = vi.fn(async () => {});
      const closeSecond = vi.fn(async () => {});
      const { runtime, exited } = createRuntimeWithExitSignal();
      const { start, started } = createSignaledStart(closeFirst);

      await runLoopWithStart({ start, runtime, lockPort: 18789, healthHost: "10.0.0.25" });
      await waitForStart(started);
      start.mockResolvedValue(createGatewayServer(closeSecond));
      const restartSignal = captureSignal("SIGUSR2");
      const sigterm = captureSignal("SIGTERM");

      restartSignal();
      await waitForLoopTurn();

      expect(waitForGatewayHealthyRestart).toHaveBeenCalledWith(
        expect.objectContaining({ port: 18789, probeHosts: ["10.0.0.25"] }),
      );
      expect(kill).toHaveBeenCalledTimes(1);
      expect(markUpdateRestartSentinelFailure).toHaveBeenCalledWith("restart-unhealthy");
      expect(start).toHaveBeenCalledTimes(2);

      sigterm();
      await expect(exited).resolves.toBe(0);
    });
  });

  it("catches SIGTERM handler errors, logs them, and falls back to stop (#83131)", async () => {
    consumeGatewayRestartIntentPayloadSync.mockImplementationOnce(() => {
      throw new Error("dynamic import failed");
    });

    await withIsolatedSignals(async ({ captureSignal }) => {
      const { close, runtime, exited } = await createSignaledLoopHarness();
      const sigterm = captureSignal("SIGTERM");

      sigterm();

      await expect(exited).resolves.toBe(0);
      expect(gatewayLog.error).toHaveBeenCalledWith(
        "failed to handle SIGTERM: Error: dynamic import failed",
      );
      expect(close).toHaveBeenCalledWith({
        reason: "gateway stopping",
        restartExpectedMs: null,
      });
      expect(runtime.exit).toHaveBeenCalledWith(0);
    });
  });

  it("catches SIGUSR2 handler errors even when token cleanup throws (#83131)", async () => {
    consumeGatewayRestartIntentPayloadSync.mockImplementationOnce(() => {
      throw new Error("lifecycle module corrupted");
    });
    markGatewayRestartHandled.mockImplementationOnce(() => {
      throw new Error("recovery import also failed");
    });

    await withIsolatedSignals(async ({ captureSignal }) => {
      const { close, start, exited } = await createSignaledLoopHarness();
      const restartSignal = captureSignal("SIGUSR2");
      const sigterm = captureSignal("SIGTERM");

      restartSignal();
      await waitForLoopTurn();
      await waitForLoopTurn();

      expect(gatewayLog.error).toHaveBeenCalledWith(
        "SIGUSR2 handler failed: lifecycle module corrupted",
      );
      expect(markGatewayRestartHandled).toHaveBeenCalled();
      expect(rollbackGatewayRestartSignalAdmission).toHaveBeenCalledOnce();
      expect(close).not.toHaveBeenCalled();
      expect(start).toHaveBeenCalledTimes(1);

      sigterm();
      await expect(exited).resolves.toBe(0);
    });
  });

  it("recloses restart admission after a failed SIGUSR2 handler rolls it back", async () => {
    markGatewayRestartHandled.mockImplementationOnce(() => {
      throw new Error("restart token cleanup failed");
    });

    await withIsolatedSignals(async ({ captureSignal }) => {
      const { close, start, exited } = await createSignaledLoopHarness();
      const restartSignal = captureSignal("SIGUSR2");
      const sigterm = captureSignal("SIGTERM");

      restartSignal();
      await waitForLoopCondition(
        () => rollbackGatewayRestartSignalAdmission.mock.calls.length === 1,
        "failed SIGUSR2 handler did not roll back restart admission",
      );

      restartSignal();
      await waitForLoopCondition(
        () => start.mock.calls.length === 2,
        "second SIGUSR2 did not start a restart",
      );

      expect(close).toHaveBeenCalledTimes(1);
      expect(gatewayWorkAdmissionActual.isGatewayWorkAdmissionClosed()).toBe(false);

      sigterm();
      await expect(exited).resolves.toBe(0);
    });
  });
  it("waits for the launchd restart throttle before settling a successful handoff", async () => {
    setPlatform("darwin");
    process.env.OPENCLAW_LAUNCHD_LABEL = "ai.openclaw.gateway";
    restartGatewayProcessWithFreshPid.mockReturnValueOnce({
      mode: "supervised",
      handoffSpawned: Promise.resolve(true),
    });
    await withIsolatedSignals(async ({ captureSignal }) => {
      const { runtime, exited } = await createSignaledLoopHarness();
      vi.useFakeTimers();
      captureSignal("SIGUSR2")();
      await vi.advanceTimersByTimeAsync(1499);
      expect(runtime.exit).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await expect(exited).resolves.toBe(0);
      expect(runtime.exit).toHaveBeenCalledWith(0);
      expectRestartHandoffCall({
        restartKind: "full-process",
        reason: undefined,
        supervisorMode: "launchd",
      });
    });
  });

  it("bounds a launchd-supervised stop on the deadline the printed job reports", async () => {
    setPlatform("darwin");
    process.env.OPENCLAW_LAUNCHD_LABEL = "ai.openclaw.gateway";
    readLaunchdStopTimeout.mockResolvedValue({
      stop: { timeoutMs: 30_000, source: "launchd system/ai.openclaw.gateway exit timeout" },
    });
    hasManagedProviderLocalServices.mockReturnValue(true);
    stopManagedProviderLocalServices.mockReturnValue(new Promise<void>(() => {}));
    await withIsolatedSignals(async ({ captureSignal }) => {
      const { close, runtime } = await createSignaledLoopHarness();
      vi.useFakeTimers();
      const clock = vi.spyOn(performance, "now").mockImplementation(() => Date.now());
      try {
        captureSignal("SIGTERM")();
        await vi.advanceTimersByTimeAsync(24_999);
        expect(close).toHaveBeenCalledOnce();
        expect(stopManagedProviderLocalServices).toHaveBeenCalledOnce();
        expect(runtime.exit).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        // launchd owns the successor, so an abandoned drain still exits 0 for the job.
        expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(0);
        expect(writeDiagnosticStabilityBundleForFailureSync).toHaveBeenCalledWith(
          "gateway.stop_shutdown_timeout",
          undefined,
        );
        expect(gatewayLog.info).toHaveBeenCalledWith(
          "shutdown budget at shutdown: drain=15000ms shutdown=25000ms reserve=10000ms exitMargin=5000ms; source=launchd system/ai.openclaw.gateway exit timeout=30000ms",
        );
      } finally {
        clock.mockRestore();
        vi.clearAllTimers();
        vi.useRealTimers();
      }
    });
  });
});

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
