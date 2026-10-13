import { performance } from "node:perf_hooks";
import { expect, it, vi } from "vitest";
import type { GatewayServer } from "../../gateway/server-public.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  createCloseMock,
  createRuntimeWithExitSignal,
  createSignaledStart,
  createUpdateRespawnChild,
  setPlatform,
  waitForStart,
  withIsolatedSignals,
  type UpdateRespawnFixtures,
} from "./run-loop.test-support.js";

export function registerGatewayRestartOwnershipTests({
  consumeGatewayRestartIntentPayload,
  readCgroup,
  systemctl,
  consumeGatewayRestartIntent,
  runLoopWithStart,
  acquireGatewayLock,
  gatewayLog,
  managedUpdateSuccessorOwner,
  isForegroundUpdateHandoff,
  completeForegroundUpdateHandoffAfterClose,
  respawnGatewayProcessForUpdate,
  cancelManagedServiceUpdateHandoff,
  requestManagedServiceUpdateHandoffPark,
  waitForGatewayHealthyRestart,
  restartGatewayProcessWithFreshPid,
  commitManagedServiceUpdateHandoff,
}: UpdateRespawnFixtures) {
  it.each(
    [false, true].flatMap((noRespawn) =>
      [false, true].map((cleanupCompletes) => ({ noRespawn, cleanupCompletes })),
    ),
  )(
    "keeps restart ownership inside a service cgroup (noRespawn=$noRespawn, cleanupCompletes=$cleanupCompletes)",
    async ({ noRespawn, cleanupCompletes }) => {
      if (noRespawn) {
        process.env.OPENCLAW_SYSTEMD_UNIT = "openclaw-gateway.service";
        process.env.OPENCLAW_NO_RESPAWN = "1";
      }
      readCgroup.mockResolvedValue("0::/system.slice/setup_and_run_blacksmith.service\n");
      systemctl.mockResolvedValue({
        code: 0,
        stdout: "LoadState=loaded\nTimeoutStopUSec=90s",
        stderr: "",
      });
      consumeGatewayRestartIntent.mockReturnValueOnce({ force: true });
      await withIsolatedSignals(async ({ captureSignal }) => {
        const cleanup = createDeferredCore();
        const close = createCloseMock().mockImplementationOnce(() => cleanup.promise);
        const { start, started } = createSignaledStart(close);
        const { runtime, exited } = createRuntimeWithExitSignal();
        await runLoopWithStart({ start, runtime });
        await waitForStart(started);
        const stop = captureSignal("SIGINT");
        vi.useFakeTimers();
        try {
          captureSignal("SIGUSR2")();
          await vi.advanceTimersByTimeAsync(11_000);
          expect(close).toHaveBeenCalledOnce();
          expect(runtime.exit).not.toHaveBeenCalled();
          if (cleanupCompletes) {
            cleanup.resolve();
            await vi.advanceTimersByTimeAsync(0);
            expect(start).toHaveBeenCalledTimes(2);
          } else {
            await vi.advanceTimersByTimeAsync(74_000);
            expect(runtime.exit).not.toHaveBeenCalled();
            cleanup.resolve();
            await vi.advanceTimersByTimeAsync(0);
            expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(1);
            expect(start).toHaveBeenCalledOnce();
          }
          expect(acquireGatewayLock).toHaveBeenCalledWith(
            expect.objectContaining({
              listenerMode: noRespawn ? "supervised" : "foreground",
              supervisor: noRespawn ? { kind: "systemd", name: "openclaw-gateway.service" } : null,
            }),
          );
          expect(gatewayLog.info).toHaveBeenCalledWith(expect.stringContaining("shutdown=85000ms"));
        } finally {
          cleanup.resolve();
          await vi.advanceTimersByTimeAsync(0);
          if (runtime.exit.mock.calls.length === 0) {
            stop();
            await vi.advanceTimersByTimeAsync(0);
            await exited;
          }
          vi.useRealTimers();
        }
      });
    },
  );
  it.each(["completed", "unconfirmed"] as const)(
    "passes the remaining forced restart budget and reports %s cleanup before process exit",
    async (outcome) => {
      setPlatform("linux");
      vi.stubEnv("OPENCLAW_SYSTEMD_UNIT", "openclaw-gateway.service");
      vi.stubEnv("OPENCLAW_SUPERVISOR_MODE", "external");
      consumeGatewayRestartIntentPayload.mockResolvedValueOnce({ force: true });
      systemctl.mockResolvedValue({
        code: 0,
        stdout: "LoadState=loaded\nTimeoutStopUSec=90s",
        stderr: "",
      });
      await withIsolatedSignals(async ({ captureSignal }) => {
        let cleanupDeadline: number | undefined;
        const close = vi.fn<GatewayServer["close"]>(async () => {
          cleanupDeadline = getProcessCleanupBudget()?.deadline;
          await new Promise<void>((resolve, reject) => {
            if (outcome === "completed") {
              setTimeout(resolve, 6_000);
            } else {
              setTimeout(() => {
                setImmediate(() => reject(new Error("service child extinction unconfirmed")));
              }, cleanupDeadline! - performance.now());
            }
          });
        });
        const { start, started } = createSignaledStart(close);
        const { runtime, exited } = createRuntimeWithExitSignal();
        await runLoopWithStart({ start, runtime });
        await waitForStart(started);
        const { getProcessCleanupBudget } =
          await import("../../process/supervisor/cleanup-budget.js");
        vi.useFakeTimers();
        const clock = vi.spyOn(performance, "now").mockReturnValue(1_000);
        try {
          captureSignal("SIGTERM")();
          await vi.advanceTimersByTimeAsync(5_000);
          expect(close).toHaveBeenCalledOnce();
          expect(runtime.exit).not.toHaveBeenCalled();
          await vi.advanceTimersByTimeAsync(outcome === "completed" ? 1_000 : 80_001);
          await expect(exited).resolves.toBe(outcome === "completed" ? 0 : 1);
          expect(cleanupDeadline).toBe(85_000);
          expect(start).toHaveBeenCalledOnce();
        } finally {
          clock.mockRestore();
          vi.useRealTimers();
        }
      });
    },
  );

  it.each(["completed", "unconfirmed"] as const)(
    "retains the post-park foreground update cleanup budget inside a service cgroup (%s)",
    async (outcome) => {
      readCgroup.mockResolvedValue("0::/system.slice/setup_and_run_blacksmith.service\n");
      systemctl.mockResolvedValue({
        code: 0,
        stdout: "LoadState=loaded\nTimeoutStopUSec=90s",
        stderr: "",
      });
      consumeGatewayRestartIntent.mockReturnValueOnce({
        reason: "update.run",
        force: true,
        waitMs: 300_000,
        successorOwner: managedUpdateSuccessorOwner,
      });
      isForegroundUpdateHandoff.mockReturnValue(true);
      const closing = createDeferredCore();
      const settlement = createDeferredCore<{ respawn: boolean }>();
      completeForegroundUpdateHandoffAfterClose.mockReturnValueOnce(settlement.promise);
      const child = createUpdateRespawnChild();
      respawnGatewayProcessForUpdate.mockReturnValueOnce({
        mode: "spawned",
        pid: child.pid,
        child,
      });
      await withIsolatedSignals(async ({ captureSignal }) => {
        const close = createCloseMock().mockImplementationOnce(() => closing.promise);
        const { start, started } = createSignaledStart(close);
        const { runtime, exited } = createRuntimeWithExitSignal();
        const completeBoot = vi.fn();
        await runLoopWithStart({ start, runtime, lockPort: 18789, completeBoot });
        await waitForStart(started);
        const failures: unknown[] = [];
        vi.useFakeTimers();
        const clock = vi.spyOn(performance, "now").mockImplementation(() => Date.now());
        try {
          captureSignal("SIGUSR2")();
          await vi.advanceTimersByTimeAsync(0);
          expect(requestManagedServiceUpdateHandoffPark).toHaveBeenCalledExactlyOnceWith(
            managedUpdateSuccessorOwner,
          );
          expect(close).toHaveBeenCalledOnce();
          expect(acquireGatewayLock).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ listenerMode: "foreground", supervisor: null }),
          );
          await vi.advanceTimersByTimeAsync(11_000);
          expect(runtime.exit).not.toHaveBeenCalled();
          expect(cancelManagedServiceUpdateHandoff).not.toHaveBeenCalled();
          expect(completeBoot).not.toHaveBeenCalled();
          expect(completeForegroundUpdateHandoffAfterClose).not.toHaveBeenCalled();
          expect(respawnGatewayProcessForUpdate).not.toHaveBeenCalled();
          if (outcome === "completed") {
            closing.resolve();
            await vi.advanceTimersByTimeAsync(0);
            expect(completeForegroundUpdateHandoffAfterClose).toHaveBeenCalledExactlyOnceWith(
              managedUpdateSuccessorOwner,
            );
            expect(respawnGatewayProcessForUpdate).not.toHaveBeenCalled();
            expect(runtime.exit).not.toHaveBeenCalled();
            settlement.resolve({ respawn: true });
            await vi.advanceTimersByTimeAsync(0);
            expect(respawnGatewayProcessForUpdate).toHaveBeenCalledExactlyOnceWith(
              expect.objectContaining({
                decision: expect.objectContaining({ mode: "disabled", reason: "unmanaged" }),
              }),
            );
            expect(waitForGatewayHealthyRestart).toHaveBeenCalledExactlyOnceWith(
              expect.objectContaining({ child, port: 18789 }),
            );
            expect(cancelManagedServiceUpdateHandoff).not.toHaveBeenCalled();
            expect(child.kill).not.toHaveBeenCalled();
          } else {
            await vi.advanceTimersByTimeAsync(73_999);
            expect(runtime.exit).not.toHaveBeenCalled();
            expect(cancelManagedServiceUpdateHandoff).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(1);
            expect(cancelManagedServiceUpdateHandoff).toHaveBeenCalledExactlyOnceWith(
              managedUpdateSuccessorOwner,
            );
            expect(completeForegroundUpdateHandoffAfterClose).not.toHaveBeenCalled();
            expect(respawnGatewayProcessForUpdate).not.toHaveBeenCalled();
            expect(runtime.exit).not.toHaveBeenCalled();
            closing.resolve();
            await vi.advanceTimersByTimeAsync(0);
          }
          const exitCode = outcome === "completed" ? 0 : 1;
          expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(exitCode);
          await expect(exited).resolves.toBe(exitCode);
          expect(completeBoot).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({
              outcome: outcome === "completed" ? "planned_restart" : "forced_stop",
            }),
          );
          expect(start).toHaveBeenCalledOnce();
          expect(restartGatewayProcessWithFreshPid).not.toHaveBeenCalled();
          expect(commitManagedServiceUpdateHandoff).not.toHaveBeenCalled();
        } catch (error) {
          failures.push(error);
        }
        try {
          closing.resolve();
          settlement.resolve({ respawn: false });
          await vi.advanceTimersByTimeAsync(0);
          if (!runtime.exit.mock.calls.length) {
            captureSignal("SIGINT")();
          }
          child.exitCode = 0;
          child.emit("exit", 0, null);
          child.emit("close", 0, null);
          await vi.advanceTimersByTimeAsync(0);
          expect(runtime.exit).toHaveBeenCalledOnce();
          await exited;
        } catch (error) {
          failures.push(error);
        } finally {
          clock.mockRestore();
          vi.useRealTimers();
        }
        if (failures.length > 1) {
          throw new AggregateError(
            failures,
            "Foreground cleanup budget assertion and cleanup failed",
            {
              cause: failures[0],
            },
          );
        }
        if (failures.length === 1) {
          throw failures[0];
        }
      });
    },
  );
}
