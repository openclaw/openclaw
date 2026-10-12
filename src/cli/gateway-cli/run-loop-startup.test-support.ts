import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withTestTimeout } from "../../../test/helpers/promise.js";
import { GATEWAY_STARTUP_MAINTENANCE_REQUIRED_REASON } from "../../infra/startup-maintenance-required.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { setTestEnvValue } from "../../test-utils/env.js";
import {
  createCloseMock,
  createGatewayServer,
  createRuntimeWithExitSignal,
  setPlatform,
  withIsolatedSignals,
  type UpdateRespawnFixtures,
} from "./run-loop.test-support.js";

export function registerGatewayStartupFailureTests(
  gatewayLog: ReturnType<typeof import("./run-loop.test-support.js").createGatewayLogger>,
  {
    hasManagedProviderLocalServices,
    stopManagedProviderLocalServices,
  }: Pick<
    UpdateRespawnFixtures,
    "hasManagedProviderLocalServices" | "stopManagedProviderLocalServices"
  >,
): void {
  // Runtime module resets must not replace the mock instances retained by the registered factories.
  // Consume the collection-time fixture instead of re-importing its registry inside a test.
  it.each(["begin-boot", "start", "deferred-startup", "maintenance"] as const)(
    "joins the real process snapshot owner after a clean %s failure before reporting drained",
    async (phase) => {
      const { retainSnapshotWork } =
        await import("../../infra/sqlite-readonly-location-cleanup.js");
      const { SessionStoreMigrationRequiredError } =
        await import("../../config/sessions/migration-required.js");
      const { runGatewayLoop } = await import("./run-loop.js");
      const failure =
        phase === "maintenance"
          ? new SessionStoreMigrationRequiredError("fixture maintenance required")
          : new Error("fixture initial startup refused");
      const snapshotStopped = createDeferredCore();
      const snapshotReleased = createDeferredCore();
      const receipt = vi.fn();
      const close = createCloseMock();
      let snapshotWork: Promise<void> | undefined;
      const retainSnapshot = () => {
        snapshotWork = retainSnapshotWork(snapshotReleased.promise, () =>
          snapshotStopped.resolve(),
        );
      };
      hasManagedProviderLocalServices.mockReturnValue(true);
      const start = vi.fn<Parameters<typeof runGatewayLoop>[0]["start"]>(async (options) => {
        retainSnapshot();
        if (phase === "deferred-startup") {
          return createGatewayServer(close, Promise.reject(failure));
        }
        // The operation retains the original refusal; drain still has to join descendants.
        return await options!.startupOperation!(async () => {
          throw failure;
        });
      });
      await withIsolatedSignals(async () => {
        const loop = runGatewayLoop({
          start,
          beginBoot:
            phase === "begin-boot"
              ? async () => {
                  retainSnapshot();
                  throw failure;
                }
              : undefined,
          onProcessResourcesSettled: receipt,
        });
        const outcome = loop.then(
          () => undefined,
          (error: unknown) => error,
        );
        try {
          await awaitGateBeforeSettlement(
            snapshotStopped.promise,
            outcome,
            "startup failure returned before draining its process snapshot owner",
          );
          expect(stopManagedProviderLocalServices).toHaveBeenCalledOnce();
          expect(close).toHaveBeenCalledTimes(phase === "deferred-startup" ? 1 : 0);
          expect(start).toHaveBeenCalledTimes(phase === "begin-boot" ? 0 : 1);
          expect(receipt).not.toHaveBeenCalled();
          snapshotReleased.resolve();
          await expect(loop).rejects.toBe(failure);
          expect(receipt).toHaveBeenCalledExactlyOnceWith("drained");
        } finally {
          snapshotReleased.resolve();
          await outcome;
          await snapshotWork;
        }
      });
    },
  );

  it.each(["acquisition-cleanup", "wrapped-acquisition-cleanup", "returned-handle-close"] as const)(
    "retains %s failure without sweeping the process snapshot owner",
    async (phase) => {
      const { GatewayStartupCleanupError } = await import("../../gateway/server-shutdown.js");
      const { retainSnapshotWork } =
        await import("../../infra/sqlite-readonly-location-cleanup.js");
      const { runGatewayLoop } = await import("./run-loop.js");
      const failure = new Error("fixture startup failed");
      const cleanupFailure = new Error("native cleanup unconfirmed");
      const retained = new GatewayStartupCleanupError(failure, cleanupFailure);
      const wrapped = new Error("wrapped startup failure", { cause: retained });
      const snapshotReleased = createDeferredCore();
      const stopSnapshot = vi.fn();
      let snapshotWork: Promise<void> | undefined;
      const receipt = vi.fn();
      hasManagedProviderLocalServices.mockReturnValue(true);
      await withIsolatedSignals(async () => {
        try {
          const loop = runGatewayLoop({
            start: async () => {
              snapshotWork = retainSnapshotWork(snapshotReleased.promise, stopSnapshot);
              if (phase !== "returned-handle-close") {
                throw phase === "wrapped-acquisition-cleanup" ? wrapped : retained;
              }
              return createGatewayServer(async () => {
                throw cleanupFailure;
              }, Promise.reject(failure));
            },
            onProcessResourcesSettled: receipt,
          });
          if (phase === "wrapped-acquisition-cleanup") {
            await expect(loop).rejects.toBe(wrapped);
          } else {
            await expect(loop).rejects.toMatchObject({
              name: "GatewayStartupCleanupError",
              errors: [failure, cleanupFailure],
            });
          }
          expect(stopManagedProviderLocalServices).not.toHaveBeenCalled();
          expect(stopSnapshot).not.toHaveBeenCalled();
          expect(receipt).toHaveBeenCalledExactlyOnceWith("retained");
        } finally {
          snapshotReleased.resolve();
          await snapshotWork;
        }
      });
    },
  );

  it.each([
    { cleanup: "clean", supervised: false, platform: "linux" },
    { cleanup: "failed", supervised: false, platform: "linux" },
    { cleanup: "maintenance", supervised: false, platform: "linux" },
    { cleanup: "unrepaired", supervised: false, platform: "linux" },
    { cleanup: "unrepaired", supervised: true, platform: "linux" },
    { cleanup: "repair-failed", supervised: false, platform: "linux" },
    { cleanup: "repair-failed", supervised: true, platform: "linux" },
    { cleanup: "unavailable", supervised: false, platform: "win32" },
    { cleanup: "unavailable", supervised: true, platform: "win32" },
  ] as const)(
    "fences replacement after deferred startup with $cleanup cleanup (supervised=$supervised, platform=$platform)",
    async ({ cleanup, supervised, platform }) => {
      setPlatform(platform);
      vi.clearAllMocks();
      if (supervised) {
        setTestEnvValue(
          platform === "win32" ? "OPENCLAW_WINDOWS_TASK_NAME" : "OPENCLAW_SYSTEMD_UNIT",
          "openclaw-gateway",
        );
      }
      await withIsolatedSignals(async ({ captureSignal }) => {
        const { runGatewayLoop } = await import("./run-loop.test-support.js");
        const firstStartup = createDeferredCore();
        const firstStarted = createDeferredCore();
        const triageStarted = createDeferredCore();
        const manualRecovery = createDeferredCore();
        gatewayLog.error.mockImplementation((message: string) => {
          if (message.includes("Process will stay alive for manual recovery")) {
            manualRecovery.resolve();
          }
        });
        const thirdStarted = createDeferredCore();
        const { SessionStoreMigrationRequiredError } =
          await import("../../config/sessions/migration-required.js");
        const startupError =
          cleanup === "maintenance"
            ? new SessionStoreMigrationRequiredError("legacy session store requires migration")
            : new Error("gateway.bind: refused configuration");
        const cleanupError = new Error("replacement cleanup failed");
        const retryError = new Error("repaired configuration still refused");
        const closeFirst = createCloseMock();
        const closeSecond = createCloseMock();
        if (cleanup === "failed") {
          closeSecond.mockRejectedValueOnce(cleanupError);
        }
        const closeThird = createCloseMock();
        const start = vi
          .fn<Parameters<typeof runGatewayLoop>[0]["start"]>()
          .mockImplementationOnce(async () => {
            firstStarted.resolve();
            return createGatewayServer(closeFirst, firstStartup.promise);
          })
          .mockImplementationOnce(async () =>
            createGatewayServer(closeSecond, Promise.reject(startupError)),
          )
          .mockImplementationOnce(async () => {
            thirdStarted.resolve();
            if (cleanup === "unrepaired") {
              throw retryError;
            }
            return createGatewayServer(closeThird);
          });
        const { runtime, exited } = createRuntimeWithExitSignal();
        const onRestartStartupFailure = vi.fn(async (error: unknown) => {
          triageStarted.resolve();
          expect(error).toBe(startupError);
          expect(closeSecond).toHaveBeenCalledExactlyOnceWith({ reason: "gateway startup failed" });
          return cleanup === "unavailable"
            ? undefined
            : cleanup === "repair-failed"
              ? ("failed" as const)
              : ("completed" as const);
        });
        const completeBoot = vi.fn();
        const loop = runGatewayLoop({ start, runtime, completeBoot, onRestartStartupFailure });
        const loopRejected = vi.fn<(error: unknown) => void>();
        const loopSettled = loop.catch(loopRejected);
        let stop: (() => void) | undefined;
        try {
          await Promise.race([firstStarted.promise, loopSettled]);
          expect(start).toHaveBeenCalledOnce();
          const restart = captureSignal("SIGUSR2");
          stop = captureSignal("SIGTERM");
          restart();
          await Promise.race([loopSettled, triageStarted.promise]);
          expect(closeSecond).toHaveBeenCalledExactlyOnceWith({
            reason: "gateway startup failed",
          });
          if (cleanup === "clean") {
            expect(onRestartStartupFailure).toHaveBeenCalledOnce();
            expect(loopRejected).not.toHaveBeenCalled();
            await withTestTimeout(
              thirdStarted.promise,
              1_000,
              "expected settled triage to restart the Gateway without another signal",
            );
            expect(start).toHaveBeenCalledTimes(3);
            stop();
            await expect(exited).resolves.toBe(0);
          } else if (supervised && (cleanup === "unrepaired" || cleanup === "repair-failed")) {
            await withTestTimeout(loopSettled, 1_000, "expected terminal startup refusal");
            const error = cleanup === "unrepaired" ? retryError : startupError;
            expect(loopRejected).toHaveBeenCalledExactlyOnceWith(error);
            expect(onRestartStartupFailure).toHaveBeenCalledOnce();
            expect(start).toHaveBeenCalledTimes(cleanup === "unrepaired" ? 3 : 2);
            expect(completeBoot).toHaveBeenLastCalledWith({
              outcome: "startup_failed",
              reason: error.message,
            });
          } else if (
            cleanup === "unavailable" ||
            cleanup === "unrepaired" ||
            cleanup === "repair-failed"
          ) {
            await withTestTimeout(
              Promise.race([manualRecovery.promise, loopSettled]),
              1_000,
              "expected manual recovery guidance",
            );
            expect(loopRejected).not.toHaveBeenCalled();
            expect(runtime.exit).not.toHaveBeenCalled();
            expect(onRestartStartupFailure).toHaveBeenCalledOnce();
            expect(start).toHaveBeenCalledTimes(cleanup === "unrepaired" ? 3 : 2);
            const output = gatewayLog.error.mock.calls.flat().join("\n");
            expect(output).toContain(
              cleanup === "unrepaired" ? retryError.message : "gateway.bind",
            );
            expect(output).toContain("openclaw doctor --fix");
            if (platform === "win32") {
              expect(output).toContain(supervised ? "openclaw gateway restart" : "press Ctrl+C");
              expect(output).not.toContain("kill -USR2");
            } else {
              expect(output).toContain(`kill -USR2 ${process.pid}`);
              const recovered = createDeferredCore();
              start.mockReset().mockImplementation(async () => {
                recovered.resolve();
                return createGatewayServer(closeThird);
              });
              restart();
              await withTestTimeout(
                recovered.promise,
                1_000,
                "expected operator reload to restart the Gateway",
              );
            }
            stop();
            await expect(exited).resolves.toBe(0);
          } else if (cleanup === "maintenance") {
            expect(completeBoot).toHaveBeenCalledWith({
              outcome: "startup_failed",
              reason: startupError.message,
              startupReason: GATEWAY_STARTUP_MAINTENANCE_REQUIRED_REASON,
            });
            expect(onRestartStartupFailure).not.toHaveBeenCalled();
            expect(loopRejected).toHaveBeenCalledExactlyOnceWith(startupError);
            expect(start).toHaveBeenCalledTimes(2);
          } else {
            expect(onRestartStartupFailure).not.toHaveBeenCalled();
            expect(loopRejected).toHaveBeenCalledOnce();
            await expect(loop).rejects.toBeInstanceOf(AggregateError);
            await expect(loop).rejects.toMatchObject({
              cause: startupError,
              errors: expect.arrayContaining([startupError, cleanupError]),
            });
            expect(start).toHaveBeenCalledTimes(2);
            expect(runtime.exit).not.toHaveBeenCalled();
          }
        } finally {
          gatewayLog.error.mockReset();
          firstStartup.resolve();
          await firstStartup.promise;
          if (
            loopRejected.mock.calls.length === 0 &&
            runtime.exit.mock.calls.length === 0 &&
            stop
          ) {
            stop();
            await exited;
          }
          if (loopRejected.mock.calls.length > 0) {
            await loopSettled;
          }
        }
      });
    },
  );

  it("keeps truncated startup failure reasons free of lone surrogates", async () => {
    await withIsolatedSignals(async () => {
      const failure = `${"a".repeat(499)}😀tail`;
      const { runtime } = createRuntimeWithExitSignal();
      const completeBoot = vi.fn();
      const { runGatewayLoop } = await import("./run-loop.test-support.js");
      await expect(
        runGatewayLoop({
          start: vi.fn(async () => {
            throw new Error(failure);
          }) as unknown as Parameters<typeof runGatewayLoop>[0]["start"],
          runtime: runtime as unknown as Parameters<typeof runGatewayLoop>[0]["runtime"],
          completeBoot,
        }),
      ).rejects.toThrow(failure);

      const reason =
        (completeBoot.mock.calls[0]?.[0] as { reason?: string } | undefined)?.reason ?? "";
      expect(reason).toHaveLength(499);
      expect(Buffer.from(reason).toString()).toBe(reason);
    });
  });

  it.each(["stopped daemon", "message-only error", "failed cleanup"] as const)(
    "retains the startup failure classification for %s",
    async (kind) => {
      await withIsolatedSignals(async () => {
        const { TailscaleBackendStoppedError } =
          await import("../../infra/tailscale-backend-stopped-error.js");
        const { GatewayStartupCleanupError } = await import("../../gateway/server-shutdown.js");
        const stopped = new TailscaleBackendStoppedError();
        const failure =
          kind === "stopped daemon"
            ? stopped
            : kind === "message-only error"
              ? new Error(stopped.message)
              : new GatewayStartupCleanupError(stopped, new Error("cleanup failed"));
        const completeBoot = vi.fn();
        const { runGatewayLoop } = await import("./run-loop.js");
        await expect(
          runGatewayLoop({
            start: vi.fn(async () => {
              throw failure;
            }),
            completeBoot,
          }),
        ).rejects.toBe(failure);
        expect(completeBoot).toHaveBeenCalledWith({
          outcome: "startup_failed",
          reason:
            kind === "failed cleanup" ? expect.stringContaining("cleanup failed") : stopped.message,
          ...(kind === "stopped daemon"
            ? { startupReason: "gateway.tailscale_backend_stopped" }
            : {}),
        });
      });
    },
  );
}
