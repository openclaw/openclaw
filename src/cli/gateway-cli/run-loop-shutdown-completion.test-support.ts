import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { LAUNCH_AGENT_EXIT_TIMEOUT_SECONDS } from "../../daemon/launchd-plist.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { expectCallCount } from "./run-loop-cleanup.test-support.js";
import { registerTimedOutGatewayStopTests } from "./run-loop-stop-timeout.test-support.js";
import {
  createLifecycleGate,
  createGatewayServer,
  expectStopCloseCall,
  expectUncalled,
  advanceWithoutCalls,
  setPlatform,
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

export function registerGracefulGatewayShutdownTests(f: UpdateRespawnFixtures): void {
  registerTimedOutGatewayStopTests(f);

  it("exits 0 on SIGTERM after graceful close", async () => {
    const gatewayStateOwner = { release: vi.fn(async () => {}) };
    f.acquireGatewayLock.mockResolvedValueOnce(gatewayStateOwner);
    await f.withRunningGateway(async ({ captureSignal, close, start, runtime, exited }) => {
      expect(start.mock.calls[0]?.[0]?.gatewayStateOwner).toBe(gatewayStateOwner);
      const localServiceStop = createLifecycleGate();
      f.stopManagedProviderLocalServices.mockImplementationOnce(localServiceStop.wait);
      f.hasManagedProviderLocalServices.mockReturnValueOnce(true);
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
      f.flushLogger.mockImplementationOnce(async () => {
        expect(runtime.exit).not.toHaveBeenCalled();
        timelineAtLogFlush = existsSync(timelinePath)
          ? readFileSync(timelinePath, "utf8")
          : undefined;
      });

      try {
        captureSignal("SIGTERM")();
        await localServiceStop.entered;

        expectStopCloseCall(close);
        expectUncalled(runtime.exit, f.flushLogger);
        localServiceStop.release();

        await expect(exited).resolves.toBe(0);
        expect(timelineAtLogFlush).toContain('"name":"gateway.stop"');
        expect(f.armShutdownHardExitWatchdog).not.toHaveBeenCalled();
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
        await f.withRunningGateway(async ({ captureSignal, close, runtime, exited, start }) => {
          close.mockImplementationOnce(closing.wait);
          captureSignal("SIGUSR2")();
          await closing.entered;
          const eof = once(input, "end");
          input.end();
          await eof;
          expect(runtime.exit).not.toHaveBeenCalled();
          closing.release();
          await expect(exited).resolves.toBe(0);
          expectCallCount(1, runtime.exit, start);
          expect(
            (await f.acquireGatewayLock.mock.results[0]?.value)?.release,
          ).toHaveBeenCalledOnce();
          expectUncalled(f.restartGatewayProcessWithFreshPid, f.respawnGatewayProcessForUpdate);
        }, true);
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
        const { consolePatched, streamErrorHandlersInstalled, rawConsole } = loggingState;
        const streams = [process.stdout, process.stderr].map((stream) => ({
          stream,
          listeners: new Set(stream.listeners("error")),
        }));
        loggingState.consolePatched = false;
        loggingState.streamErrorHandlersInstalled = false;
        enableConsoleCapture();
        let finishLoop: Promise<number> | undefined;
        try {
          await f.withRunningGateway(async ({ captureSignal, close, runtime, exited, start }) => {
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
            f.flushLogger.mockImplementationOnce(flushing.wait);
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
            expectUncalled(runtime.exit, exit);
            closing.release();
            await flushing.entered;
            if (phase === "during flush") {
              failOutput();
            }
            expectUncalled(runtime.exit, exit);
            flushing.release();
            await expect(exited).resolves.toBe(failed ? 1 : code);
            expectCallCount(restart ? 2 : 1, close, start);
            expect(
              (await f.acquireGatewayLock.mock.results.at(-1)?.value)?.release,
            ).toHaveBeenCalledOnce();
            expect(exit).not.toHaveBeenCalled();
          }, true);
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
          Object.assign(loggingState, { consolePatched, streamErrorHandlersInstalled, rawConsole });
          restoreConsoleSnapshot(consoleSnapshot);
          exit.mockRestore();
          process.exitCode = previousExitCode;
        }
      }),
  );
}

export function registerShutdownCompletionTests(f: UpdateRespawnFixtures): void {
  const delay = (ms: number) =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });
  async function withShutdownClock(
    run: Parameters<typeof f.withRunningGateway>[0],
    ownsProcessLifecycle = false,
  ) {
    await f.withRunningGateway(async (harness) => {
      vi.useFakeTimers();
      try {
        await run(harness);
      } finally {
        vi.clearAllTimers();
        vi.useRealTimers();
      }
    }, ownsProcessLifecycle);
  }

  it("reports launchd cleanup timeout after server close fails", async () => {
    const deadlineMs = LAUNCH_AGENT_EXIT_TIMEOUT_SECONDS * 1_000 - 5_000;
    process.env.OPENCLAW_LAUNCHD_LABEL = "ai.openclaw.gateway";
    setPlatform("darwin");
    f.hasManagedProviderLocalServices.mockReturnValue(true);
    f.stopManagedProviderLocalServices.mockImplementation(() => delay(2_000));
    await withShutdownClock(async ({ captureSignal, close, runtime }) => {
      close.mockImplementationOnce(async () => {
        await delay(deadlineMs - 1_000);
        throw new Error("close owner failed");
      });
      const clock = vi.spyOn(performance, "now").mockImplementation(() => Date.now());
      try {
        captureSignal("SIGTERM")();
        await vi.advanceTimersByTimeAsync(deadlineMs - 1);
        expectCallCount(1, close, f.stopManagedProviderLocalServices);
        expect(runtime.exit).not.toHaveBeenCalled();
        await advanceWithoutCalls(1, runtime.exit);
        await vi.advanceTimersByTimeAsync(2_000);
        expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(1);
        expect(f.writeDiagnosticStabilityBundleForFailureSync).toHaveBeenLastCalledWith(
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
    f.consumeGatewayRestartIntent.mockReturnValueOnce({
      force: true,
      waitMs: 0,
      reason: "update.run",
      successorOwner: f.managedUpdateSuccessorOwner,
    });
    f.cancelManagedServiceUpdateHandoff
      .mockResolvedValueOnce("restart-after-exit")
      .mockResolvedValue("restored-in-process");
    f.commitManagedServiceUpdateHandoff.mockResolvedValueOnce(true);
    await withShutdownClock(async ({ captureSignal, close, start, runtime }) => {
      const cleanup = createDeferredCore();
      close.mockReturnValue(cleanup.promise);
      captureSignal("SIGUSR2")();
      await vi.advanceTimersByTimeAsync(9_999);
      expect(f.requestManagedServiceUpdateHandoffPark).toHaveBeenCalledWith(
        f.managedUpdateSuccessorOwner,
      );
      expect(runtime.exit).not.toHaveBeenCalled();
      await advanceWithoutCalls(1, runtime.exit);
      cleanup.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(0);
      expect(start).toHaveBeenCalledOnce();
      expect(f.commitManagedServiceUpdateHandoff).toHaveBeenCalledWith(
        f.managedUpdateSuccessorOwner,
        "restore",
      );
      expect(f.writeDiagnosticStabilityBundleForFailureSync).toHaveBeenCalledWith(
        "gateway.restart_shutdown_timeout",
        undefined,
      );
    });
  });

  it("bounds the file-log flush before a SIGUSR2 exit", async () => {
    await withShutdownClock(async ({ captureSignal, close, runtime, exited }) => {
      close.mockRejectedValueOnce(new Error("close owner failed"));
      const flushed = createDeferredCore();
      f.flushLogger.mockReturnValueOnce(flushed.promise);
      try {
        captureSignal("SIGUSR2")();
        await advanceWithoutCalls(2_999, runtime.exit);
        await vi.advanceTimersByTimeAsync(1);
        expect(f.gatewayLog.warn).toHaveBeenCalledWith(
          "log flush did not settle within 3000ms; waiting for accepted writes",
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
    f.consumeGatewayRestartIntent.mockReturnValueOnce({ force: true, waitMs: 0 });
    f.restartGatewayProcessWithFreshPid.mockReturnValueOnce({ mode: "supervised" });
    await withShutdownClock(async ({ captureSignal, close, runtime, exited }) => {
      f.flushLogger.mockRejectedValueOnce(new Error("shutdown cleanup failed"));
      captureSignal("SIGUSR2")();
      await vi.advanceTimersByTimeAsync(0);
      expectCallCount(1, close, f.armShutdownHardExitWatchdog);
      expectCallCount(0, runtime.exit, f.cancelShutdownHardExitWatchdog);
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(exited).resolves.toBe(1);
    }, true);
  });
}
