/** Registers shutdown joins and deadlines in the original run-loop signal fixture. */
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
import {
  createActiveWorkSnapshot,
  expectRestartCloseCall,
  createGatewayServer,
  setPlatform,
  withIsolatedSignals,
  type UpdateRespawnFixtures,
} from "./run-loop.test-support.js";

export function registerGracefulGatewayShutdownTests({
  consumeGatewayRestartIntentPayloadSync,
  consumeGatewaySuspendHandoff,
  restartGatewayProcessWithFreshPid,
  respawnGatewayProcessForUpdate,
  waitForGatewayActiveWork,
  gatewayLog,
  acquireGatewayLock,
  createSignaledLoopHarness,
  hasManagedProviderLocalServices,
  stopManagedProviderLocalServices,
  flushLogger,
  requestGatewayRestartWithSignalAdmission,
  armShutdownHardExitWatchdog,
}: UpdateRespawnFixtures): void {
  it("exits 0 on SIGTERM after graceful close", async () => {
    vi.clearAllMocks();
    const gatewayStateOwner = { release: vi.fn(async () => {}) };
    acquireGatewayLock.mockResolvedValueOnce(gatewayStateOwner);

    await withIsolatedSignals(async ({ captureSignal }) => {
      const { close, start, runtime, exited } = await createSignaledLoopHarness();
      let finishLocalServiceStop: (() => void) | undefined;
      const localServiceStopStarted = new Promise<void>((resolveStarted) => {
        stopManagedProviderLocalServices.mockImplementationOnce(
          () =>
            new Promise<void>((resolveStop) => {
              finishLocalServiceStop = resolveStop;
              resolveStarted();
            }),
        );
      });
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
        await localServiceStopStarted;

        expect(close).toHaveBeenCalledWith({
          reason: "gateway stopping",
          restartExpectedMs: null,
        });
        expect(runtime.exit).not.toHaveBeenCalled();
        expect(flushLogger).not.toHaveBeenCalled();
        if (!finishLocalServiceStop) {
          throw new Error("managed local service stop did not start");
        }
        finishLocalServiceStop();

        await expect(exited).resolves.toBe(0);
        expect(start).toHaveBeenCalledWith({
          processStartedAt: expect.any(Number),
          startupStartedAt: expect.any(Number),
          requestHotReloadRecovery: requestGatewayRestartWithSignalAdmission,
          hostLifecycle: expect.objectContaining({ request: expect.any(Function) }),
          startupOperation: expect.any(Function),
          gatewayStateOwner,
        });
        expect(runtime.exit).toHaveBeenCalledWith(0);
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
  it("joins graceful shutdown on host EOF without consuming restart intent", async () => {
    const input = new PassThrough();
    vi.stubEnv("OPENCLAW_GATEWAY_HOST_LIFELINE", "stdin");
    const stdin = Object.getOwnPropertyDescriptor(process, "stdin");
    Object.defineProperty(process, "stdin", { configurable: true, get: () => input });
    consumeGatewayRestartIntentPayloadSync.mockReturnValue({ reason: "gateway.restart" });
    consumeGatewaySuspendHandoff.mockReturnValue({ ok: true, value: true });
    const closing = createDeferredCore();
    const closed = createDeferredCore();
    try {
      await withIsolatedSignals(async () => {
        const { close, runtime, exited, start } = await createSignaledLoopHarness();
        close.mockImplementationOnce(async () => {
          closing.resolve();
          await closed.promise;
        });
        input.end();
        await closing.promise;
        expect(runtime.exit).not.toHaveBeenCalled();
        expect(close).toHaveBeenCalledExactlyOnceWith({
          reason: "gateway stopping",
          restartExpectedMs: null,
        });
        closed.resolve();
        await expect(exited).resolves.toBe(0);
        expect(runtime.exit).toHaveBeenCalledOnce();
        expect(start).toHaveBeenCalledOnce();
        expect((await acquireGatewayLock.mock.results[0]?.value)?.release).toHaveBeenCalledOnce();
        expect(flushLogger).toHaveBeenCalledOnce();
        expect(consumeGatewayRestartIntentPayloadSync).not.toHaveBeenCalled();
        expect(consumeGatewaySuspendHandoff).not.toHaveBeenCalled();
        expect(restartGatewayProcessWithFreshPid).not.toHaveBeenCalled();
        expect(respawnGatewayProcessForUpdate).not.toHaveBeenCalled();
      });
    } finally {
      closed.resolve();
      input.destroy();
      if (stdin) {
        Object.defineProperty(process, "stdin", stdin);
      }
      vi.unstubAllEnvs();
    }
  });

  it.each([
    { phase: "before EOF", restart: false, code: 0, failed: false },
    { phase: "during close", restart: true, code: 0, failed: false },
    { phase: "during flush", restart: false, code: 7, failed: false },
    { phase: "during flush", restart: false, code: 7, failed: true },
  ])(
    "joins host cleanup for EPIPE $phase (restart=$restart, failure=$failed)",
    async ({ phase, restart, code, failed }) => {
      const input = new PassThrough();
      const stdin = Object.getOwnPropertyDescriptor(process, "stdin");
      const previousExitCode = process.exitCode;
      Object.defineProperty(process, "stdin", { configurable: true, get: () => input });
      vi.stubEnv("OPENCLAW_GATEWAY_HOST_LIFELINE", "stdin");
      const closing = createDeferredCore();
      const closed = createDeferredCore();
      const flushing = createDeferredCore();
      const flushed = createDeferredCore();
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
          const { close, runtime, exited, start } = await createSignaledLoopHarness();
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
            closing.resolve();
            await closed.promise;
            if (failed) {
              throw new Error("Gateway cleanup failed");
            }
          });
          flushLogger.mockImplementationOnce(async () => {
            flushing.resolve();
            await flushed.promise;
          });
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
          await closing.promise;
          if (phase === "during close") {
            failOutput();
          }
          expect(runtime.exit).not.toHaveBeenCalled();
          expect(exit).not.toHaveBeenCalled();
          closed.resolve();
          await flushing.promise;
          if (phase === "during flush") {
            failOutput();
          }
          expect(runtime.exit).not.toHaveBeenCalled();
          expect(exit).not.toHaveBeenCalled();
          flushed.resolve();
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
        closed.resolve();
        flushed.resolve();
        input.end();
        await finishLoop;
        input.destroy();
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
        if (stdin) {
          Object.defineProperty(process, "stdin", stdin);
        }
        process.exitCode = previousExitCode;
        vi.unstubAllEnvs();
      }
    },
  );

  it("stops a closing restart when the host lifeline closes", async () => {
    const input = new PassThrough();
    vi.stubEnv("OPENCLAW_GATEWAY_HOST_LIFELINE", "stdin");
    const stdin = Object.getOwnPropertyDescriptor(process, "stdin");
    Object.defineProperty(process, "stdin", { configurable: true, get: () => input });
    const closing = createDeferredCore();
    const closed = createDeferredCore();
    try {
      await withIsolatedSignals(async ({ captureSignal }) => {
        const { close, runtime, exited, start } = await createSignaledLoopHarness();
        close.mockImplementationOnce(async () => {
          closing.resolve();
          await closed.promise;
        });
        captureSignal("SIGUSR2")();
        await closing.promise;
        const eof = once(input, "end");
        input.end();
        await eof;
        closed.resolve();
        await expect(exited).resolves.toBe(0);
        expect(runtime.exit).toHaveBeenCalledOnce();
        expect(start).toHaveBeenCalledOnce();
        expect(restartGatewayProcessWithFreshPid).not.toHaveBeenCalled();
        expect(respawnGatewayProcessForUpdate).not.toHaveBeenCalled();
      });
    } finally {
      closed.resolve();
      input.destroy();
      if (stdin) {
        Object.defineProperty(process, "stdin", stdin);
      }
      vi.unstubAllEnvs();
    }
  });

  it("still closes and exits when the direct-shutdown active-work drain fails", async () => {
    vi.clearAllMocks();

    await withIsolatedSignals(async ({ captureSignal }) => {
      waitForGatewayActiveWork.mockRejectedValueOnce(new Error("active-work drain unavailable"));
      const { close, runtime, exited } = await createSignaledLoopHarness();

      captureSignal("SIGTERM")();

      await expect(exited).resolves.toBe(0);
      expect(waitForGatewayActiveWork).toHaveBeenCalledWith(315_000, {
        onSnapshot: expect.any(Function),
      });
      expect(gatewayLog.warn).toHaveBeenCalledWith(
        "gateway active-work drain failed; proceeding with shutdown: active-work drain unavailable",
      );
      expect(close).toHaveBeenCalledWith({
        reason: "gateway stopping",
        restartExpectedMs: null,
      });
      expect(runtime.exit).toHaveBeenCalledWith(0);
    });
  });
}

export function registerShutdownCompletionTests({
  consumeGatewayRestartIntentPayloadSync,
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
  writeGatewayRestartHandoffSync,
  flushLogger,
  restartGatewayProcessWithFreshPid,
  gatewayLog,
  armShutdownHardExitWatchdog,
  cancelShutdownHardExitWatchdog,
  writeDiagnosticStabilityBundleForFailureSync,
}: UpdateRespawnFixtures): void {
  it("reports failure when foreground provider service cleanup times out after server close", async () => {
    vi.clearAllMocks();
    hasManagedProviderLocalServices.mockReturnValue(true);
    stopManagedProviderLocalServices.mockReturnValue(new Promise<void>(() => {}));
    await withIsolatedSignals(async ({ captureSignal }) => {
      const { close, runtime } = await createSignaledLoopHarness();
      vi.useFakeTimers();
      try {
        captureSignal("SIGTERM")();
        await vi.advanceTimersByTimeAsync(324_999);
        expect(close).toHaveBeenCalledOnce();
        expect(stopManagedProviderLocalServices).toHaveBeenCalledOnce();
        expect(runtime.exit).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(1);
        expect(writeDiagnosticStabilityBundleForFailureSync).toHaveBeenCalledWith(
          "gateway.stop_shutdown_timeout",
          undefined,
        );
      } finally {
        vi.clearAllTimers();
        vi.useRealTimers();
      }
    });
  });

  it("preserves a recorded close failure when launchd final cleanup crosses the deadline", async () => {
    vi.clearAllMocks();
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
    await withIsolatedSignals(async ({ captureSignal }) => {
      const { close, runtime } = await createSignaledLoopHarness();
      close.mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, deadlineMs - 1_000);
        });
        throw new Error("close owner failed");
      });
      vi.useFakeTimers();
      const clock = vi.spyOn(performance, "now").mockImplementation(() => Date.now());
      try {
        captureSignal("SIGTERM")();
        await vi.advanceTimersByTimeAsync(deadlineMs - 1);
        expect(gatewayLog.error).toHaveBeenCalledWith(
          "shutdown step failed (gateway server close): close owner failed",
        );
        expect(stopManagedProviderLocalServices).toHaveBeenCalledOnce();
        expect(runtime.exit).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(1);
        expect(writeDiagnosticStabilityBundleForFailureSync).toHaveBeenLastCalledWith(
          "gateway.stop_shutdown_timeout",
          expect.objectContaining({ message: "close owner failed" }),
          { shutdownStep: "gateway-server-close" },
        );
      } finally {
        clock.mockRestore();
        vi.clearAllTimers();
        vi.useRealTimers();
      }
    });
  });

  it.each([true, false])(
    "bounds abandoned cleanup after a zero-drain request and managed parking (restore commit=%s)",
    async (restoreCommitted) => {
      vi.clearAllMocks();
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
      commitManagedServiceUpdateHandoff.mockResolvedValueOnce(restoreCommitted);
      await withIsolatedSignals(async ({ captureSignal }) => {
        const { close, start, runtime } = await createSignaledLoopHarness();
        close.mockReturnValue(new Promise<void>(() => {}));
        vi.useFakeTimers();
        try {
          captureSignal("SIGUSR2")();
          await vi.advanceTimersByTimeAsync(9_999);
          expect(requestManagedServiceUpdateHandoffPark).toHaveBeenCalledWith(
            managedUpdateSuccessorOwner,
          );
          expect(close).toHaveBeenCalledOnce();
          expect(runtime.exit).not.toHaveBeenCalled();
          await vi.advanceTimersByTimeAsync(1);
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
        } finally {
          vi.clearAllTimers();
          vi.useRealTimers();
        }
      });
    },
  );

  it("retains external supervisor recovery when timeout prevents a restart handoff", async () => {
    vi.clearAllMocks();
    process.env.OPENCLAW_SUPERVISOR_MODE = "external";
    consumeGatewayRestartIntent.mockReturnValueOnce({ force: true, waitMs: 0 });
    await withIsolatedSignals(async ({ captureSignal }) => {
      const { close, runtime } = await createSignaledLoopHarness();
      close.mockReturnValue(new Promise<void>(() => {}));
      vi.useFakeTimers();
      try {
        captureSignal("SIGUSR2")();
        await vi.advanceTimersByTimeAsync(9_999);
        expect(runtime.exit).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(writeGatewayRestartHandoffSync).not.toHaveBeenCalled();
        expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(1);
      } finally {
        vi.clearAllTimers();
        vi.useRealTimers();
      }
    });
  });

  it.each([
    { signal: "SIGTERM", timeoutMs: 4_000 },
    { signal: "SIGUSR2", timeoutMs: 1_000 },
  ] as const)("bounds the file-log flush before a $signal exit", async ({ signal, timeoutMs }) => {
    vi.clearAllMocks();

    await withIsolatedSignals(async ({ captureSignal }) => {
      const { close, runtime, exited } = await createSignaledLoopHarness();
      if (signal === "SIGUSR2") {
        close.mockRejectedValueOnce(new Error("close owner failed"));
      }
      const signalExit = captureSignal(signal);
      flushLogger.mockReturnValueOnce(new Promise<void>(() => {}));
      vi.useFakeTimers();
      try {
        signalExit();
        await vi.advanceTimersByTimeAsync(timeoutMs);

        await expect(exited).resolves.toBe(signal === "SIGUSR2" ? 1 : 0);
        expect(runtime.exit).toHaveBeenCalledWith(signal === "SIGUSR2" ? 1 : 0);
        expect(gatewayLog.warn).toHaveBeenCalledWith(
          `log flush did not settle within ${timeoutMs}ms; continuing shutdown`,
        );
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("retains the restart deadline when a managed update arrives after final cleanup fails", async () => {
    vi.clearAllMocks();
    process.env.OPENCLAW_SUPERVISOR_MODE = "external";
    consumeGatewayRestartIntent.mockReturnValueOnce({ force: true, waitMs: 0 });
    restartGatewayProcessWithFreshPid.mockReturnValueOnce({ mode: "supervised" });
    await withIsolatedSignals(async ({ captureSignal }) => {
      const { close, start, runtime, exited } = await createSignaledLoopHarness(undefined, true);
      flushLogger.mockRejectedValueOnce(new Error("shutdown cleanup failed"));
      const restartSignal = captureSignal("SIGUSR2");
      vi.useFakeTimers();
      try {
        restartSignal();
        await vi.advanceTimersByTimeAsync(0);
        expect(close).toHaveBeenCalledOnce();
        expect(gatewayLog.error).toHaveBeenCalledWith(
          "gateway lifecycle completion failed: shutdown cleanup failed",
        );
        consumeGatewayRestartIntent.mockReturnValueOnce({
          force: true,
          reason: "update.run",
          successorOwner: managedUpdateSuccessorOwner,
        });
        restartSignal();
        await vi.advanceTimersByTimeAsync(9_999);
        expect(runtime.exit).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(1);
        await expect(exited).resolves.toBe(1);
        expect(cancelManagedServiceUpdateHandoff).toHaveBeenCalledExactlyOnceWith(
          managedUpdateSuccessorOwner,
        );
        expect(requestManagedServiceUpdateHandoffPark).not.toHaveBeenCalled();
        expect(start).toHaveBeenCalledOnce();
        expect(armShutdownHardExitWatchdog).toHaveBeenCalledOnce();
        expect(cancelShutdownHardExitWatchdog).not.toHaveBeenCalled();
      } finally {
        vi.clearAllTimers();
        vi.useRealTimers();
      }
    });
  });

  it.each([
    { signal: "SIGTERM", failure: "exit handler" },
    { signal: "SIGUSR2", failure: "log flush" },
  ] as const)(
    "retains $signal deadlines when $failure throws after server close",
    async ({ signal, failure }) => {
      vi.clearAllMocks();
      process.env.OPENCLAW_SUPERVISOR_MODE = "external";
      restartGatewayProcessWithFreshPid.mockReturnValueOnce({ mode: "supervised" });
      await withIsolatedSignals(async ({ captureSignal }) => {
        const { close, runtime, exited } = await createSignaledLoopHarness(undefined, true);
        const error = new TypeError("shutdown cleanup failed");
        if (failure === "exit handler") {
          runtime.exit.mockImplementationOnce(() => {
            throw error;
          });
        } else {
          flushLogger.mockRejectedValueOnce(error);
        }
        vi.useFakeTimers();
        try {
          captureSignal(signal)();
          await vi.advanceTimersByTimeAsync(0);
          expect(close).toHaveBeenCalledOnce();
          expect(gatewayLog.error).toHaveBeenCalledWith(
            "gateway lifecycle completion failed: shutdown cleanup failed",
          );
          expect(armShutdownHardExitWatchdog).toHaveBeenCalledOnce();
          expect(cancelShutdownHardExitWatchdog).not.toHaveBeenCalled();
          await vi.advanceTimersByTimeAsync(625_000);
          await expect(exited).resolves.toBe(1);
        } finally {
          vi.clearAllTimers();
          vi.useRealTimers();
        }
      });
    },
  );

  it("waits for the drain before handing recovery ownership to server close", async () => {
    consumeGatewayRestartIntentPayloadSync.mockReturnValueOnce({ waitMs: 0 });
    const drainStart = createActiveWorkSnapshot({ embeddedRuns: 2 }, [
      { kind: "embedded-run", count: 2, message: "2 active embedded run(s)" },
    ]);
    let releaseDrain: (() => void) | undefined;
    const pendingDrain = new Promise<void>((resolve) => {
      releaseDrain = resolve;
    });
    createGatewayActiveWorkSnapshot.mockReturnValueOnce(drainStart);
    waitForGatewayActiveWork.mockImplementationOnce(async () => {
      // Recovery ownership must be collected later by server close, after this
      // window lets active work settle.
      await pendingDrain;
      return { drained: true, snapshot: idleActiveWorkSnapshot };
    });

    await withIsolatedSignals(async ({ captureSignal }) => {
      const { close, start, exited } = await createSignaledLoopHarness();
      const cleanupSignal = gatewayWorkAdmissionActual.getGatewayShutdownCleanupSignal();
      close.mockImplementationOnce(async () => {
        expect(cleanupSignal.aborted).toBe(true);
      });
      const sigterm = captureSignal("SIGTERM");

      sigterm();
      await vi.waitFor(() => expect(waitForGatewayActiveWork).toHaveBeenCalledOnce());

      expect(abortEmbeddedAgentRun).toHaveBeenCalledWith(undefined, {
        mode: "compacting",
        reason: "restart",
      });
      expect(close).not.toHaveBeenCalled();
      expect(cleanupSignal.aborted).toBe(false);

      releaseDrain?.();
      await expect(exited).resolves.toBe(0);

      expect(waitForGatewayActiveWork).toHaveBeenCalledWith(undefined, expect.any(Object));
      expectRestartCloseCall(close, 315_000);
      expect(start).toHaveBeenCalledOnce();
    });
  });
}
