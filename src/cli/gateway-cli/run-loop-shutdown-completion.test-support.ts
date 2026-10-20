import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { LAUNCH_AGENT_EXIT_TIMEOUT_SECONDS } from "../../daemon/launchd-plist.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { gatewayWorkAdmissionActual } from "./run-loop-mocks.test-support.js";
import { registerTimedOutGatewayStopTests } from "./run-loop-stop-timeout.test-support.js";
import {
  createActiveWorkSnapshot,
  createLifecycleGate,
  expectRestartCloseCall,
  createGatewayServer,
  setPlatform,
  withIsolatedSignals,
  type UpdateRespawnFixtures,
} from "./run-loop.test-support.js";

async function withHostLifeline(run: (input: PassThrough) => Promise<void>) {
  const input = new PassThrough();
  const stdin = Object.getOwnPropertyDescriptor(process, "stdin");
  vi.stubEnv("OPENCLAW_GATEWAY_HOST_LIFELINE", "stdin");
  Object.defineProperty(process, "stdin", { configurable: true, get: () => input });
  try {
    await run(input);
  } finally {
    input.destroy();
    if (stdin) {
      Object.defineProperty(process, "stdin", stdin);
    }
    vi.unstubAllEnvs();
  }
}

export function registerGracefulGatewayShutdownTests({
  restartGatewayProcessWithFreshPid,
  respawnGatewayProcessForUpdate,
  waitForGatewayActiveWork,
  acquireGatewayLock,
  createSignaledLoopHarness,
  hasManagedProviderLocalServices,
  stopManagedProviderLocalServices,
  gatewayLog,
  flushLogger,
  requestGatewayRestartWithSignalAdmission,
  armShutdownHardExitWatchdog,
  abortEmbeddedAgentRun,
  abortActiveCronTaskRuns,
}: UpdateRespawnFixtures): void {
  registerTimedOutGatewayStopTests({
    createSignaledLoopHarness,
    waitForGatewayActiveWork,
    gatewayLog,
    abortEmbeddedAgentRun,
    abortActiveCronTaskRuns,
  });

  it("exits 0 on SIGTERM after graceful close", async () => {
    const gatewayStateOwner = { release: vi.fn(async () => {}) };
    acquireGatewayLock.mockResolvedValueOnce(gatewayStateOwner);

    await withIsolatedSignals(async ({ captureSignal }) => {
      const { close, start, runtime, exited } = await createSignaledLoopHarness();
      const localServiceStop = createLifecycleGate();
      stopManagedProviderLocalServices.mockImplementationOnce(localServiceStop.wait);
      hasManagedProviderLocalServices.mockReturnValueOnce(true);
      const sigterm = captureSignal("SIGTERM");
      const { emitDiagnosticsTimelineEvent, flushDiagnosticsTimeline } =
        await import("../../infra/diagnostics-timeline.js");
      const tempDirs = createTempDirTracker();
      const timelinePath = join(tempDirs.make("openclaw-gateway-stop-"), "timeline.jsonl");
      let timelineAtLogFlush: string | undefined;
      close.mockImplementationOnce(async () => {
        emitDiagnosticsTimelineEvent(
          { type: "mark", name: "gateway.stop" },
          {
            env: {
              OPENCLAW_DIAGNOSTICS: "timeline",
              OPENCLAW_DIAGNOSTICS_TIMELINE_PATH: timelinePath,
            },
          },
        );
      });
      flushLogger.mockImplementationOnce(async () => {
        expect(runtime.exit).not.toHaveBeenCalled();
        timelineAtLogFlush = existsSync(timelinePath)
          ? readFileSync(timelinePath, "utf8")
          : undefined;
      });

      try {
        sigterm();
        await localServiceStop.entered;

        expect(close).toHaveBeenCalledWith({
          retainSharedState: true,
          reason: "gateway stopping",
          restartExpectedMs: null,
        });
        expect(runtime.exit).not.toHaveBeenCalled();
        expect(flushLogger).not.toHaveBeenCalled();
        localServiceStop.release();

        await expect(exited).resolves.toBe(0);
        expect(start).toHaveBeenCalledWith({
          processStartedAt: expect.any(Number),
          startupStartedAt: expect.any(Number),
          requestHotReloadRecovery: requestGatewayRestartWithSignalAdmission,
          hostLifecycle: expect.objectContaining({ request: expect.any(Function) }),
          startupOperation: expect.any(Function),
          gatewayStateOwner,
        });
        expect(stopManagedProviderLocalServices).toHaveBeenCalledOnce();
        expect(flushLogger).toHaveBeenCalledOnce();
        expect(timelineAtLogFlush).toContain('"name":"gateway.stop"');
        expect(armShutdownHardExitWatchdog).not.toHaveBeenCalled();
      } finally {
        flushDiagnosticsTimeline();
        tempDirs.cleanup();
      }
    });
  });
  it("joins host EOF shutdown during restart close", async () => {
    await withHostLifeline(async (input) => {
      const closing = createLifecycleGate();
      try {
        await withIsolatedSignals(async ({ captureSignal }) => {
          const { close, runtime, exited, start } = await createSignaledLoopHarness(
            undefined,
            true,
          );
          close.mockImplementationOnce(closing.wait);
          captureSignal("SIGUSR2")();
          await closing.entered;
          const eof = once(input, "end");
          input.end();
          await eof;
          expect(runtime.exit).not.toHaveBeenCalled();
          closing.release();
          await expect(exited).resolves.toBe(0);
          expect(runtime.exit).toHaveBeenCalledOnce();
          expect(start).toHaveBeenCalledOnce();
          expect((await acquireGatewayLock.mock.results[0]?.value)?.release).toHaveBeenCalledOnce();
          expect(flushLogger).toHaveBeenCalledOnce();
          expect(restartGatewayProcessWithFreshPid).not.toHaveBeenCalled();
          expect(respawnGatewayProcessForUpdate).not.toHaveBeenCalled();
        });
      } finally {
        closing.release();
      }
    });
  });

  it.each([
    { phase: "before EOF", restart: false, code: 0, failed: false },
    { phase: "during close", restart: true, code: 0, failed: false },
    { phase: "during flush", restart: false, code: 7, failed: true },
  ])(
    "joins host cleanup for EPIPE $phase (restart=$restart, failure=$failed)",
    async ({ phase, restart, code, failed }) =>
      withHostLifeline(async (input) => {
        const previousExitCode = process.exitCode;
        const closing = createLifecycleGate();
        const flushing = createLifecycleGate();
        const exit = vi.spyOn(process, "exit").mockImplementation(() => {
          throw new Error("Output failure bypassed Gateway shutdown");
        });
        const { enableConsoleCapture } = await import("../../logging/console.js");
        const { loggingState } = await import("../../logging/state.js");
        const { captureConsoleSnapshot, restoreConsoleSnapshot } =
          await import("../../logging/test-helpers/console-snapshot.js");
        const consoleSnapshot = captureConsoleSnapshot();
        const captureState = {
          consolePatched: loggingState.consolePatched,
          streamErrorHandlersInstalled: loggingState.streamErrorHandlersInstalled,
          rawConsole: loggingState.rawConsole,
        };
        const streams = [process.stdout, process.stderr].map((stream) => ({
          stream,
          listeners: new Set(stream.listeners("error")),
        }));
        loggingState.consolePatched = false;
        loggingState.streamErrorHandlersInstalled = false;
        enableConsoleCapture();
        let finishLoop: Promise<number> | undefined;
        try {
          await withIsolatedSignals(async ({ captureSignal }) => {
            const { close, runtime, exited, start } = await createSignaledLoopHarness(
              undefined,
              true,
            );
            finishLoop = exited;
            if (restart) {
              const restarted = createDeferredCore();
              start.mockImplementationOnce(async () => {
                restarted.resolve();
                return createGatewayServer(close);
              });
              captureSignal("SIGUSR2")();
              await restarted.promise;
            }
            close.mockImplementationOnce(async () => {
              await closing.wait();
              if (failed) {
                throw new Error("Gateway cleanup failed");
              }
            });
            flushLogger.mockImplementationOnce(flushing.wait);
            const failOutput = () => {
              process.exitCode = code;
              for (const { stream } of streams) {
                stream.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
              }
            };
            if (phase === "before EOF") {
              failOutput();
            } else {
              input.end();
            }
            await closing.entered;
            if (phase === "during close") {
              failOutput();
            }
            expect(runtime.exit).not.toHaveBeenCalled();
            expect(exit).not.toHaveBeenCalled();
            closing.release();
            await flushing.entered;
            if (phase === "during flush") {
              failOutput();
            }
            expect(runtime.exit).not.toHaveBeenCalled();
            expect(exit).not.toHaveBeenCalled();
            flushing.release();
            await expect(exited).resolves.toBe(failed ? 1 : code);
            expect(runtime.exit).toHaveBeenCalledOnce();
            expect(close).toHaveBeenCalledTimes(restart ? 2 : 1);
            expect(start).toHaveBeenCalledTimes(restart ? 2 : 1);
            expect(
              (await acquireGatewayLock.mock.results.at(-1)?.value)?.release,
            ).toHaveBeenCalledOnce();
            expect(exit).not.toHaveBeenCalled();
          });
        } finally {
          closing.release();
          flushing.release();
          input.end();
          await finishLoop;
          for (const { stream, listeners } of streams) {
            for (const listener of stream.listeners("error")) {
              if (!listeners.has(listener)) {
                stream.off("error", listener);
              }
            }
          }
          Object.assign(loggingState, captureState);
          restoreConsoleSnapshot(consoleSnapshot);
          exit.mockRestore();
          process.exitCode = previousExitCode;
        }
      }),
  );

  it("still closes and exits when the direct-shutdown active-work drain fails", async () => {
    await withIsolatedSignals(async ({ captureSignal }) => {
      waitForGatewayActiveWork.mockRejectedValueOnce(new Error("active-work drain unavailable"));
      const { close, exited } = await createSignaledLoopHarness();

      captureSignal("SIGTERM")();

      await expect(exited).resolves.toBe(0);
      expect(waitForGatewayActiveWork).toHaveBeenCalledWith(20_000, {
        onSnapshot: expect.any(Function),
      });
      expect(close).toHaveBeenCalledWith({
        retainSharedState: true,
        reason: "gateway stopping",
        restartExpectedMs: null,
      });
    });
  });
}

export function registerShutdownCompletionTests({
  consumeGatewayRestartIntentPayload,
  createGatewayActiveWorkSnapshot,
  waitForGatewayActiveWork,
  idleActiveWorkSnapshot,
  abortEmbeddedAgentRun,
  hasManagedProviderLocalServices,
  stopManagedProviderLocalServices,
  createSignaledLoopHarness,
  consumeGatewayRestartIntent,
  managedUpdateSuccessorOwner,
  cancelManagedServiceUpdateHandoff,
  commitManagedServiceUpdateHandoff,
  requestManagedServiceUpdateHandoffPark,
  flushLogger,
  restartGatewayProcessWithFreshPid,
  gatewayLog,
  armShutdownHardExitWatchdog,
  cancelShutdownHardExitWatchdog,
  writeDiagnosticStabilityBundleForFailureSync,
}: UpdateRespawnFixtures): void {
  async function withShutdownClock(
    run: (
      context: Awaited<ReturnType<typeof createSignaledLoopHarness>> &
        Parameters<Parameters<typeof withIsolatedSignals>[0]>[0],
    ) => Promise<void>,
    ownsProcessLifecycle = false,
  ) {
    await withIsolatedSignals(async (signals) => {
      const harness = await createSignaledLoopHarness(undefined, ownsProcessLifecycle);
      vi.useFakeTimers();
      try {
        await run({ ...harness, ...signals });
      } finally {
        vi.clearAllTimers();
        vi.useRealTimers();
      }
    });
  }

  it("reports launchd cleanup timeout after server close fails", async () => {
    const deadlineMs = LAUNCH_AGENT_EXIT_TIMEOUT_SECONDS * 1_000 - 5_000;
    process.env.OPENCLAW_LAUNCHD_LABEL = "ai.openclaw.gateway";
    setPlatform("darwin");
    hasManagedProviderLocalServices.mockReturnValue(true);
    stopManagedProviderLocalServices.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, 2_000);
        }),
    );
    await withShutdownClock(async ({ captureSignal, close, runtime }) => {
      close.mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, deadlineMs - 1_000);
        });
        throw new Error("close owner failed");
      });
      const clock = vi.spyOn(performance, "now").mockImplementation(() => Date.now());
      try {
        captureSignal("SIGTERM")();
        await vi.advanceTimersByTimeAsync(deadlineMs - 1);
        expect(close).toHaveBeenCalledOnce();
        expect(stopManagedProviderLocalServices).toHaveBeenCalledOnce();
        expect(runtime.exit).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(runtime.exit).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(2_000);
        expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(1);
        expect(writeDiagnosticStabilityBundleForFailureSync).toHaveBeenLastCalledWith(
          "gateway.stop_shutdown_timeout",
          expect.objectContaining({ message: "close owner failed" }),
          { shutdownStep: "gateway-server-close" },
        );
      } finally {
        clock.mockRestore();
      }
    });
  });

  it("bounds abandoned cleanup after a zero-drain request and managed parking", async () => {
    process.env.OPENCLAW_SYSTEMD_UNIT = "openclaw-gateway.service";
    setPlatform("linux");
    consumeGatewayRestartIntent.mockReturnValueOnce({
      force: true,
      waitMs: 0,
      reason: "update.run",
      successorOwner: managedUpdateSuccessorOwner,
    });
    cancelManagedServiceUpdateHandoff
      .mockResolvedValueOnce("restart-after-exit")
      .mockResolvedValue("restored-in-process");
    commitManagedServiceUpdateHandoff.mockResolvedValueOnce(true);
    await withShutdownClock(async ({ captureSignal, close, start, runtime }) => {
      const cleanup = createDeferredCore();
      close.mockReturnValue(cleanup.promise);
      captureSignal("SIGUSR2")();
      await vi.advanceTimersByTimeAsync(9_999);
      expect(requestManagedServiceUpdateHandoffPark).toHaveBeenCalledWith(
        managedUpdateSuccessorOwner,
      );
      expect(close).toHaveBeenCalledOnce();
      expect(runtime.exit).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(runtime.exit).not.toHaveBeenCalled();
      cleanup.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(0);
      expect(start).toHaveBeenCalledOnce();
      expect(commitManagedServiceUpdateHandoff).toHaveBeenCalledWith(
        managedUpdateSuccessorOwner,
        "restore",
      );
      expect(writeDiagnosticStabilityBundleForFailureSync).toHaveBeenCalledWith(
        "gateway.restart_shutdown_timeout",
        undefined,
      );
    });
  });

  it("warns but joins the file-log flush before a SIGUSR2 exit", async () => {
    await withShutdownClock(async ({ captureSignal, close, runtime, exited }) => {
      close.mockRejectedValueOnce(new Error("close owner failed"));
      const flushed = createDeferredCore();
      flushLogger.mockReturnValueOnce(flushed.promise);
      try {
        captureSignal("SIGUSR2")();
        await vi.advanceTimersByTimeAsync(999);
        expect(runtime.exit).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(runtime.exit).not.toHaveBeenCalled();
        expect(gatewayLog.warn).toHaveBeenCalledWith(
          "log flush did not settle within 1000ms; waiting for accepted writes",
        );
      } finally {
        flushed.resolve();
        await vi.advanceTimersByTimeAsync(0);
      }
      await expect(exited).resolves.toBe(1);
    });
  });

  it("retains the deadline after owned log cleanup fails", async () => {
    process.env.OPENCLAW_SUPERVISOR_MODE = "external";
    consumeGatewayRestartIntent.mockReturnValueOnce({ force: true, waitMs: 0 });
    restartGatewayProcessWithFreshPid.mockReturnValueOnce({ mode: "supervised" });
    await withShutdownClock(async ({ captureSignal, close, runtime, exited }) => {
      flushLogger.mockRejectedValueOnce(new Error("shutdown cleanup failed"));
      captureSignal("SIGUSR2")();
      await vi.advanceTimersByTimeAsync(0);
      expect(close).toHaveBeenCalledOnce();
      expect(gatewayLog.error).toHaveBeenCalledWith(
        "gateway lifecycle completion failed: shutdown cleanup failed",
      );
      expect(runtime.exit).not.toHaveBeenCalled();
      expect(armShutdownHardExitWatchdog).toHaveBeenCalledOnce();
      expect(cancelShutdownHardExitWatchdog).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(exited).resolves.toBe(1);
    }, true);
  });

  it("waits for the drain before handing recovery ownership to server close", async () => {
    consumeGatewayRestartIntentPayload.mockResolvedValueOnce({ waitMs: 0 });
    createGatewayActiveWorkSnapshot.mockReturnValueOnce(
      createActiveWorkSnapshot({ embeddedRuns: 2 }, [
        { kind: "embedded-run", count: 2, message: "2 active embedded run(s)" },
      ]),
    );
    const draining = createLifecycleGate();
    waitForGatewayActiveWork.mockImplementationOnce(async () => {
      await draining.wait();
      return { drained: true, snapshot: idleActiveWorkSnapshot };
    });
    await withIsolatedSignals(async ({ captureSignal }) => {
      const { close, start, exited } = await createSignaledLoopHarness();
      const cleanupSignal = gatewayWorkAdmissionActual.getGatewayShutdownCleanupSignal();
      close.mockImplementationOnce(async () => {
        expect(cleanupSignal.aborted).toBe(true);
      });
      captureSignal("SIGTERM")();
      await draining.entered;
      expect(abortEmbeddedAgentRun).toHaveBeenCalledWith(undefined, {
        mode: "compacting",
        reason: "restart",
      });
      expect(close).not.toHaveBeenCalled();
      expect(cleanupSignal.aborted).toBe(false);
      draining.release();
      await expect(exited).resolves.toBe(0);
      expect(waitForGatewayActiveWork).toHaveBeenCalledExactlyOnceWith(
        undefined,
        expect.any(Object),
      );
      expectRestartCloseCall(close, 315_000);
      expect(start).toHaveBeenCalledOnce();
    });
  });
}
