import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import { SUPERVISOR_HINT_ENV_VARS } from "../../infra/supervisor-markers.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../../test-utils/env.js";
import { registerGatewayStartupFailureSettlementTests } from "./run-loop-startup-settlement.test-support.js";
import {
  createCloseMock,
  createGatewayServer,
  originalPlatformDescriptor,
  setPlatform,
  waitForLoopCondition,
  withIsolatedSignals,
  type UpdateRespawnFixtures,
} from "./run-loop.test-support.js";

function isolateSupervisorEnv() {
  const env = captureEnv([...SUPERVISOR_HINT_ENV_VARS]);
  for (const key of SUPERVISOR_HINT_ENV_VARS) {
    deleteTestEnvValue(key);
  }
  return env;
}

export function registerGatewayStartupFailureTests(
  gatewayLog: ReturnType<typeof import("./run-loop.test-support.js").createGatewayLogger>,
  fixtures: Pick<
    UpdateRespawnFixtures,
    "acquireGatewayLock" | "hasManagedProviderLocalServices" | "stopManagedProviderLocalServices"
  >,
): void {
  const { acquireGatewayLock } = fixtures;
  it.each(["initial drain", "drain after acknowledging the auth failure"] as const)(
    "completes boot before rethrowing a distinct startup failure from the %s",
    async (failureDrain) => {
      const env = isolateSupervisorEnv();
      setPlatform("linux");
      setTestEnvValue("OPENCLAW_SYSTEMD_UNIT", "openclaw-gateway.service");
      try {
        await withIsolatedSignals(async () => {
          const { TailscaleBackendAuthenticationRequiredError } =
            await import("../../infra/tailscale-backend-ready.js");
          const { runGatewayLoop } = await import("./run-loop.js");
          const startupError = new TailscaleBackendAuthenticationRequiredError(
            "NeedsLogin",
            "serve",
            { bin: "tailscale", prefix: [] },
          );
          const additionalStartupError = new Error("distinct tracked startup failure");
          const close = createCloseMock();
          const releaseLock = vi.fn(async () => {});
          acquireGatewayLock.mockResolvedValueOnce({ release: releaseLock });
          const start = vi
            .fn<Parameters<typeof runGatewayLoop>[0]["start"]>()
            .mockImplementationOnce(async (options) => {
              const startupOperation = options?.startupOperation;
              if (!startupOperation) {
                throw new Error("expected the run loop to provide tracked startup ownership");
              }
              const trackedFailures =
                failureDrain === "initial drain"
                  ? [additionalStartupError]
                  : [startupError, additionalStartupError];
              for (const failure of trackedFailures) {
                try {
                  await startupOperation(async () => {
                    throw failure;
                  });
                } catch (error) {
                  expect(error).toBe(failure);
                }
              }
              return createGatewayServer(close, Promise.reject(startupError));
            });
          const completeBoot = vi.fn();
          const onRestartStartupFailure = vi.fn();

          await expect(
            runGatewayLoop({ start, completeBoot, onRestartStartupFailure }),
          ).rejects.toBe(additionalStartupError);

          expect(start).toHaveBeenCalledOnce();
          expect(close).toHaveBeenCalledExactlyOnceWith({
            reason: "gateway startup failed",
            retainSharedState: true,
          });
          expect(releaseLock).toHaveBeenCalledOnce();
          expect(onRestartStartupFailure).not.toHaveBeenCalled();
          expect(completeBoot).toHaveBeenCalledOnce();
          expect(completeBoot).toHaveBeenCalledWith(
            expect.objectContaining({
              outcome: "startup_failed",
              reason: additionalStartupError.message,
            }),
          );
          expect(completeBoot.mock.calls[0]?.[0]).not.toHaveProperty("startupReason");
        });
      } finally {
        env.restore();
        if (originalPlatformDescriptor) {
          Object.defineProperty(process, "platform", originalPlatformDescriptor);
        }
      }
    },
  );

  it("joins recovery cleanup failure after shutdown without masking the failure", async () => {
    const { createGatewayRestartRecovery } = await import("./run-loop-startup.js");
    const failureStarted = createDeferredCore();
    const finishFailedRecovery = createDeferredCore();
    const failedRecovery = createGatewayRestartRecovery(
      {
        onRestartStartupFailure: async () => {
          failureStarted.resolve();
          await finishFailedRecovery.promise;
          throw new Error("recovery cleanup failed");
        },
      },
      gatewayLog,
      null,
    );
    const failedAttempt = failedRecovery.attempt(new Error("startup failed"));
    await awaitGateBeforeSettlement(
      failureStarted.promise,
      failedAttempt,
      "recovery attempt settled before its handler started",
    );
    failedRecovery.abort();
    const failedCleanup = failedRecovery.waitForCleanup();
    finishFailedRecovery.resolve();
    await expect(failedAttempt).resolves.toBe(false);
    await expect(failedCleanup).rejects.toThrow("recovery cleanup failed");
  });

  const runTrackedStartupStop = async () => {
    const env = isolateSupervisorEnv();
    setPlatform("linux");
    setTestEnvValue("OPENCLAW_SYSTEMD_UNIT", "openclaw-gateway.service");
    try {
      await withIsolatedSignals(async ({ captureSignal }) => {
        const {
          TailscaleBackendAuthenticationRequiredError,
          waitForTailscaleBackendReady,
          waitForTailscaleBackendRunning,
        } = await import("../../infra/tailscale-backend-ready.js");
        const processExec = await import("../../process/exec.js");
        const { runGatewayLoop } = await import("./run-loop.js");
        const close = createCloseMock();
        const releaseLock = vi.fn(async () => {});
        acquireGatewayLock.mockResolvedValueOnce({ release: releaseLock });
        const statusCommand = { bin: "sudo", prefix: ["-n", "tailscale"] };
        const start = vi
          .fn<Parameters<typeof runGatewayLoop>[0]["start"]>()
          .mockImplementationOnce(async (options) => {
            const startupOperation = options?.startupOperation;
            if (!startupOperation) {
              throw new Error("expected the run loop to provide tracked startup ownership");
            }
            return await startupOperation(async (signal) => {
              try {
                await waitForTailscaleBackendReady({
                  ...statusCommand,
                  managedMode: "serve",
                  info: vi.fn(),
                  signal,
                });
              } catch (error) {
                startupError = error;
                throw error;
              }
              return createGatewayServer(close);
            });
          });
        const recoveryWaitStarted = createDeferredCore();
        const recoveryAbortObserved = createDeferredCore();
        const recoveryWaitCleanup = createDeferredCore();
        const recoverySettled = createDeferredCore();
        let startupError: unknown;
        let statusCalls = 0;
        const statusExec = vi
          .spyOn(processExec, "runExec")
          .mockImplementation(async (_command, _args, options) => {
            statusCalls += 1;
            if (statusCalls === 1) {
              return {
                stdout: JSON.stringify({ BackendState: "NeedsLogin" }),
                stderr: "",
              };
            }
            if (statusCalls !== 2) {
              throw new Error("unexpected extra Tailscale status call");
            }
            recoveryWaitStarted.resolve();
            const signal = typeof options === "object" ? options.signal : undefined;
            if (!signal) {
              throw new Error("expected the tracked recovery waiter to receive cancellation");
            }
            return await new Promise<{ stdout: string; stderr: string }>((_resolve, reject) => {
              const rejectAfterCleanup = () => {
                recoveryAbortObserved.resolve();
                void recoveryWaitCleanup.promise.then(() => {
                  reject(new DOMException("Tailscale wait cancelled", "AbortError"));
                });
              };
              if (signal.aborted) {
                rejectAfterCleanup();
              } else {
                signal.addEventListener("abort", rejectAfterCleanup, { once: true });
              }
            });
          });
        const onRestartStartupFailure = vi.fn(async (error: unknown, signal: AbortSignal) => {
          expect(error).toBe(startupError);
          expect(error).toBeInstanceOf(TailscaleBackendAuthenticationRequiredError);
          try {
            await waitForTailscaleBackendRunning({
              ...statusCommand,
              info: vi.fn(),
              signal,
            });
            return "completed" as const;
          } finally {
            recoverySettled.resolve();
          }
        });
        const loop = runGatewayLoop({ start, onRestartStartupFailure });
        let loopSettled = false;
        void loop.then(
          () => {
            loopSettled = true;
          },
          () => {
            loopSettled = true;
          },
        );
        let shutdownRequested = false;
        let recoveryEntered = false;
        try {
          await awaitGateBeforeSettlement(
            recoveryWaitStarted.promise,
            loop,
            "Gateway loop settled before the tracked startup failure entered prerequisite recovery",
          );
          recoveryEntered = true;
          expect(statusExec).toHaveBeenCalledTimes(2);
          expect(statusExec.mock.calls.map(([command, args]) => [command, args])).toEqual([
            ["sudo", ["-n", "tailscale", "status", "--json"]],
            ["sudo", ["-n", "tailscale", "status", "--json"]],
          ]);
          expect(onRestartStartupFailure).toHaveBeenCalledOnce();
          expect(close).not.toHaveBeenCalled();
          captureSignal("SIGTERM")();
          shutdownRequested = true;
          await awaitGateBeforeSettlement(
            recoveryAbortObserved.promise,
            loop,
            "Gateway exited before cancelling the real Tailscale prerequisite waiter",
          );
          expect(loopSettled).toBe(false);
          expect(releaseLock).not.toHaveBeenCalled();
          recoveryWaitCleanup.resolve();
          await awaitGateBeforeSettlement(
            recoverySettled.promise,
            loop,
            "Gateway exited before joining the cancelled tracked prerequisite waiter",
          );
          const stopExitCode = await loop;
          expect(
            stopExitCode,
            stopExitCode === 1
              ? "tracked startup shutdown returned one instead of zero"
              : "tracked startup shutdown exit code",
          ).toBe(0);
          expect(statusExec).toHaveBeenCalledTimes(2);
          expect(onRestartStartupFailure).toHaveBeenCalledOnce();
          expect(start).toHaveBeenCalledOnce();
          expect(close).not.toHaveBeenCalled();
          expect(releaseLock).toHaveBeenCalledOnce();
        } finally {
          try {
            recoveryWaitCleanup.resolve();
            if (recoveryEntered && !shutdownRequested) {
              captureSignal("SIGTERM")();
              await loop;
            } else if (!loopSettled) {
              captureSignal("SIGTERM")();
              await loop;
            }
          } finally {
            statusExec.mockRestore();
          }
        }
      });
    } finally {
      env.restore();
      if (originalPlatformDescriptor) {
        Object.defineProperty(process, "platform", originalPlatformDescriptor);
      }
    }
  };

  it("joins the real Tailscale prerequisite waiter when shutdown cancels recovery", async () => {
    await runTrackedStartupStop();
  });

  it.each([
    ["Error", new Error("Tailscale recovery status failed")],
    ["undefined", undefined],
  ] as const)(
    "counts a terminal recovery rejection of %s as a failed boot",
    async (_kind, recoveryError) => {
      const env = isolateSupervisorEnv();
      setPlatform("linux");
      setTestEnvValue("OPENCLAW_SYSTEMD_UNIT", "openclaw-gateway.service");
      try {
        await withIsolatedSignals(async () => {
          const { TailscaleBackendAuthenticationRequiredError } =
            await import("../../infra/tailscale-backend-ready.js");
          const { runGatewayLoop } = await import("./run-loop.js");
          const startupError = new TailscaleBackendAuthenticationRequiredError(
            "NeedsLogin",
            "serve",
            { bin: "tailscale", prefix: [] },
          );
          const close = createCloseMock();
          const releaseLock = vi.fn(async () => {});
          acquireGatewayLock.mockResolvedValueOnce({ release: releaseLock });
          const start = vi
            .fn<Parameters<typeof runGatewayLoop>[0]["start"]>()
            .mockImplementationOnce(async () =>
              createGatewayServer(close, Promise.reject(startupError)),
            );
          const recoveryStarted = createDeferredCore();
          const rejectRecovery = createDeferredCore();
          void rejectRecovery.promise.catch(() => {});
          const completeBoot = vi.fn();
          const onRestartStartupFailure = vi.fn(async (error: unknown, signal: AbortSignal) => {
            expect(error).toBe(startupError);
            expect(signal.aborted).toBe(false);
            recoveryStarted.resolve();
            await rejectRecovery.promise;
          });
          const loop = runGatewayLoop({ start, completeBoot, onRestartStartupFailure });

          const settled = loop.then(
            (value) => ({ status: "fulfilled" as const, value }),
            (error: unknown) => ({ status: "rejected" as const, error }),
          );
          try {
            await awaitGateBeforeSettlement(
              recoveryStarted.promise,
              loop,
              "Gateway loop settled before the recovery waiter rejected",
            );
            expect(completeBoot).not.toHaveBeenCalled();

            rejectRecovery.reject(recoveryError);
            const outcome = await settled;
            expect(outcome.status).toBe("rejected");
            if (outcome.status === "rejected") {
              expect(outcome.error).toBe(recoveryError);
            }

            expect(start).toHaveBeenCalledOnce();
            expect(close).toHaveBeenCalledExactlyOnceWith({
              reason: "gateway startup failed",
              retainSharedState: true,
            });
            expect(releaseLock).toHaveBeenCalledOnce();
            expect(onRestartStartupFailure).toHaveBeenCalledOnce();
            expect(completeBoot).toHaveBeenCalledOnce();
            const completion = completeBoot.mock.calls[0]?.[0];
            expect(completion).toMatchObject({ outcome: "startup_failed" });
            expect(completion).not.toHaveProperty("startupReason");
            if (recoveryError instanceof Error) {
              expect(completion?.reason).toBe(recoveryError.message);
            } else {
              expect(completion?.reason).not.toBe(startupError.message);
            }
          } finally {
            rejectRecovery.reject(recoveryError);
            await settled;
          }
        });
      } finally {
        env.restore();
        if (originalPlatformDescriptor) {
          Object.defineProperty(process, "platform", originalPlatformDescriptor);
        }
      }
    },
  );

  it("parks supervised Serve startup after clean close and retries once after Running", async () => {
    const env = isolateSupervisorEnv();
    setPlatform("linux");
    setTestEnvValue("OPENCLAW_SYSTEMD_UNIT", "openclaw-gateway.service");
    try {
      await withIsolatedSignals(async ({ captureSignal }) => {
        const { TailscaleBackendAuthenticationRequiredError } =
          await import("../../infra/tailscale-backend-ready.js");
        const { runGatewayLoop } = await import("./run-loop.js");
        const startupError = new TailscaleBackendAuthenticationRequiredError(
          "NeedsLogin",
          "serve",
          {
            bin: "tailscale",
            prefix: [],
          },
        );
        const firstClose = createCloseMock();
        const secondClose = createCloseMock();
        const recoveryStarted = createDeferredCore();
        const allowRecovery = createDeferredCore();
        const secondStartup = createDeferredCore();
        const releaseLock = vi.fn(async () => {});
        const releaseRestartLock = vi.fn(async () => {});
        acquireGatewayLock
          .mockResolvedValueOnce({ release: releaseLock })
          .mockResolvedValueOnce({ release: releaseRestartLock });
        const start = vi
          .fn<Parameters<typeof runGatewayLoop>[0]["start"]>()
          .mockImplementationOnce(async () =>
            createGatewayServer(firstClose, Promise.reject(startupError)),
          )
          .mockImplementationOnce(async () =>
            createGatewayServer(secondClose, secondStartup.promise),
          );
        const beginBoot = vi.fn();
        const completeBoot = vi.fn();
        const onRestartStartupFailure = vi.fn(async (error: unknown, signal: AbortSignal) => {
          expect(error).toBe(startupError);
          expect(signal.aborted).toBe(false);
          expect(firstClose).toHaveBeenCalledExactlyOnceWith({
            reason: "gateway startup failed",
            retainSharedState: true,
          });
          recoveryStarted.resolve();
          await allowRecovery.promise;
          return "completed" as const;
        });
        const loop = runGatewayLoop({ start, beginBoot, completeBoot, onRestartStartupFailure });
        let loopFinished = false;
        void loop.then(
          () => {
            loopFinished = true;
          },
          () => {
            loopFinished = true;
          },
        );
        try {
          await awaitGateBeforeSettlement(
            recoveryStarted.promise,
            loop,
            "Gateway loop settled before supervised Serve recovery started",
          );
          expect(start).toHaveBeenCalledOnce();
          expect(firstClose).toHaveBeenCalledOnce();
          expect(acquireGatewayLock).toHaveBeenCalledOnce();
          expect(releaseLock).not.toHaveBeenCalled();
          expect(completeBoot).not.toHaveBeenCalled();
          expect(loopFinished).toBe(false);

          allowRecovery.resolve();
          await waitForLoopCondition(
            () => start.mock.calls.length === 2,
            "expected exactly one retry after the backend recovery handler completed",
          );
          expect(completeBoot.mock.calls.map(([completion]) => completion.outcome)).toEqual([
            "startup_failed",
            "planned_restart",
          ]);
          expect(beginBoot).toHaveBeenCalledTimes(2);
          expect(completeBoot.mock.invocationCallOrder[1]).toBeLessThan(
            beginBoot.mock.invocationCallOrder[1]!,
          );
          expect(completeBoot).toHaveBeenCalledWith(
            expect.objectContaining({
              outcome: "startup_failed",
              startupReason: "gateway.tailscale_authentication_required",
              reason: expect.stringContaining("NeedsLogin"),
            }),
          );
          expect(start).toHaveBeenCalledTimes(2);
          expect(firstClose).toHaveBeenCalledOnce();
          expect(releaseLock).toHaveBeenCalledOnce();
          expect(acquireGatewayLock).toHaveBeenCalledTimes(2);
          expect(releaseRestartLock).not.toHaveBeenCalled();
          expect(secondClose).not.toHaveBeenCalled();
          expect(gatewayLog.error).not.toHaveBeenCalledWith(
            expect.stringContaining("openclaw doctor --fix"),
          );

          secondStartup.resolve();
          await awaitGateBeforeSettlement(
            new Promise<void>((resolve) => {
              setImmediate(resolve);
            }),
            loop,
            "Gateway loop settled before the successful retry entered its running loop",
          );
          const stop = captureSignal("SIGTERM");
          stop();
          await expect(loop).resolves.toBe(0);
          expect(releaseLock).toHaveBeenCalledOnce();
          expect(releaseRestartLock).toHaveBeenCalledOnce();
          expect(start).toHaveBeenCalledTimes(2);
          expect(onRestartStartupFailure).toHaveBeenCalledOnce();
        } finally {
          allowRecovery.resolve();
          secondStartup.resolve();
          if (!loopFinished) {
            captureSignal("SIGTERM")();
            await loop;
          }
        }
      });
    } finally {
      env.restore();
      if (originalPlatformDescriptor) {
        Object.defineProperty(process, "platform", originalPlatformDescriptor);
      }
    }
  });

  it("keeps cleanup failures as startup failures instead of parking them", async () => {
    const env = isolateSupervisorEnv();
    setPlatform("linux");
    setTestEnvValue("OPENCLAW_SYSTEMD_UNIT", "openclaw-gateway.service");
    try {
      await withIsolatedSignals(async () => {
        const { TailscaleBackendAuthenticationRequiredError } =
          await import("../../infra/tailscale-backend-ready.js");
        const { GatewayStartupCleanupError } = await import("../../gateway/server-shutdown.js");
        const { runGatewayLoop } = await import("./run-loop.js");
        const startupError = new TailscaleBackendAuthenticationRequiredError(
          "NeedsLogin",
          "serve",
          {
            bin: "tailscale",
            prefix: [],
          },
        );
        const close = vi.fn(async () => {
          throw new Error("Tailscale route cleanup failed");
        });
        const completeBoot = vi.fn();
        const onRestartStartupFailure = vi.fn();
        const start = vi
          .fn<Parameters<typeof runGatewayLoop>[0]["start"]>()
          .mockImplementationOnce(async () =>
            createGatewayServer(close, Promise.reject(startupError)),
          );

        await expect(
          runGatewayLoop({ start, completeBoot, onRestartStartupFailure }),
        ).rejects.toBeInstanceOf(GatewayStartupCleanupError);
        expect(close).toHaveBeenCalledOnce();
        expect(onRestartStartupFailure).not.toHaveBeenCalled();
        expect(completeBoot).toHaveBeenCalledWith(
          expect.objectContaining({ outcome: "startup_failed" }),
        );
        expect(completeBoot).toHaveBeenCalledWith(
          expect.objectContaining({ outcome: "startup_failed", reason: startupError.message }),
        );
        expect(completeBoot).not.toHaveBeenCalledWith(
          expect.objectContaining({ startupReason: "gateway.tailscale_authentication_required" }),
        );
      });
    } finally {
      env.restore();
      if (originalPlatformDescriptor) {
        Object.defineProperty(process, "platform", originalPlatformDescriptor);
      }
    }
  });

  it("releases parked custody before a contended normal restart reacquire", async () => {
    const env = isolateSupervisorEnv();
    setPlatform("linux");
    setTestEnvValue("OPENCLAW_SYSTEMD_UNIT", "openclaw-gateway.service");
    try {
      await withIsolatedSignals(async () => {
        const { TailscaleBackendAuthenticationRequiredError } =
          await import("../../infra/tailscale-backend-ready.js");
        const { runGatewayLoop } = await import("./run-loop.js");
        const startupError = new TailscaleBackendAuthenticationRequiredError(
          "NeedsLogin",
          "serve",
          {
            bin: "tailscale",
            prefix: [],
          },
        );
        const firstClose = createCloseMock();
        const releaseLock = vi.fn(async () => {});
        acquireGatewayLock
          .mockResolvedValueOnce({ release: releaseLock })
          .mockRejectedValueOnce(new Error("lock already owned"));
        const start = vi
          .fn<Parameters<typeof runGatewayLoop>[0]["start"]>()
          .mockImplementationOnce(async () =>
            createGatewayServer(firstClose, Promise.reject(startupError)),
          );
        const recoveryStarted = createDeferredCore();
        const onRestartStartupFailure = vi.fn(async () => {
          recoveryStarted.resolve();
          return "completed" as const;
        });
        const loop = runGatewayLoop({ start, onRestartStartupFailure });

        await awaitGateBeforeSettlement(
          recoveryStarted.promise,
          loop,
          "Gateway loop settled before parked startup recovery started",
        );
        expect(acquireGatewayLock).toHaveBeenCalledOnce();
        expect(releaseLock).not.toHaveBeenCalled();
        await expect(loop).resolves.toBe(1);
        expect(start).toHaveBeenCalledOnce();
        expect(acquireGatewayLock).toHaveBeenCalledTimes(2);
        expect(releaseLock).toHaveBeenCalledOnce();
      });
    } finally {
      env.restore();
      if (originalPlatformDescriptor) {
        Object.defineProperty(process, "platform", originalPlatformDescriptor);
      }
    }
  });

  it("does not park a foreground Gateway for Tailscale authentication requirements", async () => {
    const env = isolateSupervisorEnv();
    setPlatform("linux");
    try {
      await withIsolatedSignals(async () => {
        const { TailscaleBackendAuthenticationRequiredError } =
          await import("../../infra/tailscale-backend-ready.js");
        const { runGatewayLoop } = await import("./run-loop.js");
        const startupError = new TailscaleBackendAuthenticationRequiredError(
          "NeedsLogin",
          "serve",
          {
            bin: "tailscale",
            prefix: [],
          },
        );
        const close = createCloseMock();
        const onRestartStartupFailure = vi.fn();
        const start = vi
          .fn<Parameters<typeof runGatewayLoop>[0]["start"]>()
          .mockImplementationOnce(async () =>
            createGatewayServer(close, Promise.reject(startupError)),
          );
        await expect(runGatewayLoop({ start, onRestartStartupFailure })).rejects.toBe(startupError);
        expect(close).toHaveBeenCalledExactlyOnceWith({
          reason: "gateway startup failed",
          retainSharedState: true,
        });
        expect(onRestartStartupFailure).not.toHaveBeenCalled();
      });
    } finally {
      env.restore();
      if (originalPlatformDescriptor) {
        Object.defineProperty(process, "platform", originalPlatformDescriptor);
      }
    }
  });
  registerGatewayStartupFailureSettlementTests(gatewayLog, fixtures);
}
