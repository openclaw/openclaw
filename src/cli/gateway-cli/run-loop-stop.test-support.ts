import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { withTimeout } from "../../infra/fs-safe.js";
import type { GatewayRestartSnapshot } from "../daemon-cli/restart-health.js";
import {
  createActiveWorkSnapshot,
  createUpdateRespawnChild,
  type UpdateRespawnFixtures,
} from "./run-loop.test-support.js";

export function registerForegroundUpdateStopTests({
  waitForGatewayActiveWork,
  requestManagedServiceUpdateHandoffPark,
  consumeGatewaySigusr1RestartIntent,
  managedUpdateSuccessorOwner,
  isForegroundUpdateHandoff,
  completeForegroundUpdateHandoffAfterClose,
  respawnGatewayProcessForUpdate,
  hasManagedProviderLocalServices,
  stopManagedProviderLocalServices,
  cancelManagedServiceUpdateHandoff,
  acquireGatewayLock,
  withIsolatedSignals,
  createSignaledLoopHarness,
  waitForLoopCondition,
  createSignaledStart,
  createRuntimeWithExitSignal,
  runLoopWithStart,
  waitForStart,
  consumeGatewayRestartIntentPayloadSync,
  commitManagedServiceUpdateHandoff,
  flushLogger,
  waitForGatewayHealthyRestart,
  respawnHealth,
  markUpdateRestartSentinelFailure,
  writeGatewayRestartHandoffSync,
  isGatewayWorkAdmissionClosed,
  gatewayLog,
}: UpdateRespawnFixtures): void {
  it("does not start a second active-work drain for repeated shutdown signals", async () => {
    vi.clearAllMocks();

    await withIsolatedSignals(async ({ captureSignal }) => {
      const { exited } = await createSignaledLoopHarness();
      let releaseDrain: (() => void) | undefined;
      const pendingDrain = new Promise<void>((resolve) => {
        releaseDrain = resolve;
      });
      waitForGatewayActiveWork.mockImplementationOnce(async () => {
        await pendingDrain;
        return { drained: true, snapshot: createActiveWorkSnapshot() };
      });

      try {
        const sigterm = captureSignal("SIGTERM");
        const sigint = captureSignal("SIGINT");
        sigterm();
        await waitForLoopCondition(
          () => waitForGatewayActiveWork.mock.calls.length === 1,
          "expected first shutdown signal to begin the active-work drain",
        );

        sigint();

        expect(waitForGatewayActiveWork).toHaveBeenCalledOnce();
        expect(isGatewayWorkAdmissionClosed()).toBe(true);
        expect(gatewayLog.info).toHaveBeenCalledWith("received SIGINT during shutdown; ignoring");

        releaseDrain?.();
        await expect(exited).resolves.toBe(0);
      } finally {
        releaseDrain?.();
        await exited;
      }
    });
  });

  it.each(
    (["parking", "provider", "lock-reacquisition"] as const).flatMap((phase) =>
      (["SIGINT", "SIGTERM"] as const).map((signal) => ({ phase, signal })),
    ),
  )(
    "stops a cancelled foreground handoff during $phase with $signal",
    async ({ phase, signal }) => {
      const entered = createDeferred();
      const release = createDeferred();
      const initialLockRelease = vi.fn(async () => {});
      const restoredLockRelease = vi.fn(async () => {});
      consumeGatewaySigusr1RestartIntent.mockReturnValueOnce({
        reason: "update.run",
        successorOwner: managedUpdateSuccessorOwner,
      });
      isForegroundUpdateHandoff.mockReturnValue(true);
      if (phase === "parking") {
        requestManagedServiceUpdateHandoffPark.mockResolvedValueOnce(false);
      } else {
        hasManagedProviderLocalServices.mockReturnValue(true);
        stopManagedProviderLocalServices.mockRejectedValueOnce(
          new Error("provider cleanup failed"),
        );
      }
      cancelManagedServiceUpdateHandoff.mockImplementationOnce(async () => {
        if (phase !== "lock-reacquisition") {
          entered.resolve();
          await release.promise;
        }
        isForegroundUpdateHandoff.mockReturnValue(false);
        return "restored-in-process";
      });
      acquireGatewayLock.mockResolvedValueOnce({ release: initialLockRelease });
      if (phase === "lock-reacquisition") {
        acquireGatewayLock.mockImplementationOnce(async () => {
          entered.resolve();
          await release.promise;
          return { release: restoredLockRelease };
        });
      }
      await withIsolatedSignals(async ({ captureSignal }) => {
        const { start, runtime, exited } = await createSignaledLoopHarness();
        try {
          captureSignal("SIGUSR1")();
          await withTimeout(entered.promise, 4_000);
          captureSignal(signal)();
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
          expect(runtime.exit).not.toHaveBeenCalled();
          expect(start).toHaveBeenCalledOnce();
          release.resolve();
          await waitForLoopCondition(
            () => runtime.exit.mock.calls.length > 0 || start.mock.calls.length > 1,
            "foreground cancellation did not settle",
          );
          expect(start).toHaveBeenCalledOnce();
          await expect(withTimeout(exited, 4_000)).resolves.toBe(0);
          expect(initialLockRelease).toHaveBeenCalledOnce();
          expect(restoredLockRelease).toHaveBeenCalledTimes(phase === "lock-reacquisition" ? 1 : 0);
          expect(acquireGatewayLock).toHaveBeenCalledTimes(phase === "lock-reacquisition" ? 2 : 1);
          expect(cancelManagedServiceUpdateHandoff).toHaveBeenCalledExactlyOnceWith(
            managedUpdateSuccessorOwner,
          );
          expect(completeForegroundUpdateHandoffAfterClose).not.toHaveBeenCalled();
          expect(respawnGatewayProcessForUpdate).not.toHaveBeenCalled();
          expect(commitManagedServiceUpdateHandoff).not.toHaveBeenCalled();
        } finally {
          release.resolve();
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
          if (runtime.exit.mock.calls.length === 0) {
            captureSignal("SIGINT")();
          }
          await withTimeout(exited, 4_000);
        }
      });
    },
  );

  it.each(
    (["drain", "server-close"] as const).flatMap((phase) => [
      { phase, signal: "SIGINT" as const, restartIntent: false },
      { phase, signal: "SIGTERM" as const, restartIntent: false },
      { phase, signal: "SIGTERM" as const, restartIntent: true },
    ]),
  )(
    "retains pre-close foreground $signal during $phase (restart intent: $restartIntent)",
    async ({ phase, signal, restartIntent }) => {
      const entered = createDeferred();
      const release = createDeferred();
      const updater = createDeferred<{ respawn: boolean }>();
      const child = createUpdateRespawnChild();
      consumeGatewaySigusr1RestartIntent.mockReturnValueOnce({
        reason: "update.run",
        successorOwner: managedUpdateSuccessorOwner,
      });
      isForegroundUpdateHandoff.mockReturnValue(true);
      completeForegroundUpdateHandoffAfterClose.mockReturnValueOnce(updater.promise);
      respawnGatewayProcessForUpdate.mockReturnValueOnce({
        mode: "spawned",
        pid: child.pid,
        child,
      });
      waitForGatewayActiveWork.mockImplementationOnce(async () => {
        if (phase === "drain") {
          entered.resolve();
          await release.promise;
        }
        return { drained: true, snapshot: createActiveWorkSnapshot() };
      });
      const close = vi.fn(async () => {
        if (phase === "server-close") {
          entered.resolve();
          await release.promise;
        }
      });
      await withIsolatedSignals(async ({ captureSignal }) => {
        const { start, started } = createSignaledStart(close);
        const { runtime, exited } = createRuntimeWithExitSignal();
        try {
          await runLoopWithStart({ start, runtime, lockPort: 18789 });
          await waitForStart(started);
          captureSignal("SIGUSR1")();
          await withTimeout(entered.promise, 4_000);
          expect(completeForegroundUpdateHandoffAfterClose).not.toHaveBeenCalled();
          if (restartIntent) {
            consumeGatewayRestartIntentPayloadSync.mockReturnValueOnce({ reason: "update.run" });
          }
          captureSignal(signal)();
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
          expect(runtime.exit).not.toHaveBeenCalled();
          expect(respawnGatewayProcessForUpdate).not.toHaveBeenCalled();
          release.resolve();
          await waitForLoopCondition(
            () => completeForegroundUpdateHandoffAfterClose.mock.calls.length === 1,
            "foreground updater did not receive its closed witness",
          );
          expect(close).toHaveBeenCalledOnce();
          expect(runtime.exit).not.toHaveBeenCalled();
          updater.resolve({ respawn: true });
          await expect(withTimeout(exited, 4_000)).resolves.toBe(0);
          expect(respawnGatewayProcessForUpdate).toHaveBeenCalledTimes(restartIntent ? 1 : 0);
          expect(start).toHaveBeenCalledOnce();
          expect(acquireGatewayLock).toHaveBeenCalledOnce();
          expect(cancelManagedServiceUpdateHandoff).not.toHaveBeenCalled();
        } finally {
          release.resolve();
          updater.resolve({ respawn: false });
          await withTimeout(exited, 4_000);
        }
      });
    },
  );

  it.each(
    (["SIGINT", "SIGTERM"] as const).flatMap((signal) =>
      (["updater", "unsafe-updater", "readiness", "log-flush"] as const).map((phase) => ({
        signal,
        phase,
      })),
    ),
  )("retains $signal stop intent during foreground $phase", async ({ signal, phase }) => {
    const updater = createDeferred<{ respawn: boolean }>();
    const readiness = createDeferred<GatewayRestartSnapshot>();
    const flushEntered = createDeferred();
    const flush = createDeferred();
    const child = createUpdateRespawnChild();
    consumeGatewaySigusr1RestartIntent.mockReturnValueOnce({
      reason: "update.run",
      successorOwner: managedUpdateSuccessorOwner,
    });
    isForegroundUpdateHandoff.mockReturnValue(true);
    completeForegroundUpdateHandoffAfterClose.mockReturnValueOnce(updater.promise);
    respawnGatewayProcessForUpdate.mockReturnValueOnce({ mode: "spawned", pid: child.pid, child });
    flushLogger.mockImplementationOnce(async () => {
      flushEntered.resolve();
      await flush.promise;
    });
    await withIsolatedSignals(async ({ captureSignal }) => {
      const { start, started } = createSignaledStart(vi.fn(async () => {}));
      const { runtime, exited } = createRuntimeWithExitSignal();
      waitForGatewayHealthyRestart.mockImplementationOnce(() => readiness.promise);
      const stop = () => captureSignal(signal)();
      try {
        await runLoopWithStart({ start, runtime, lockPort: 18789 });
        await waitForStart(started);
        captureSignal("SIGUSR1")();
        await waitForLoopCondition(
          () => completeForegroundUpdateHandoffAfterClose.mock.calls.length === 1,
          "foreground updater did not receive its closed witness",
        );
        const consumedIntents = consumeGatewayRestartIntentPayloadSync.mock.calls.length;
        const stoppingUpdater = phase === "updater" || phase === "unsafe-updater";
        if (!stoppingUpdater) {
          updater.resolve({ respawn: true });
          await waitForLoopCondition(
            () => waitForGatewayHealthyRestart.mock.calls.length === 1,
            "fresh Gateway readiness observation did not start",
          );
          if (phase === "log-flush") {
            readiness.resolve(respawnHealth());
            await withTimeout(flushEntered.promise, 4_000);
          }
        }
        stop();
        stop();
        expect(runtime.exit).not.toHaveBeenCalled();
        expect(consumeGatewayRestartIntentPayloadSync).toHaveBeenCalledTimes(consumedIntents);
        expect(cancelManagedServiceUpdateHandoff).not.toHaveBeenCalled();
        if (stoppingUpdater) {
          expect(respawnGatewayProcessForUpdate).not.toHaveBeenCalled();
          updater.resolve({ respawn: phase !== "unsafe-updater" });
        } else {
          expect(child.kill).toHaveBeenCalledExactlyOnceWith(signal);
        }
        readiness.resolve(respawnHealth());
        flush.resolve();
        if (!stoppingUpdater) {
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
          expect(runtime.exit).not.toHaveBeenCalled();
          child.exitCode = 0;
          child.emit("exit", 0, null);
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
          expect(runtime.exit).not.toHaveBeenCalled();
          child.emit("close", 0, null);
        }
        await expect(withTimeout(exited, 4_000)).resolves.toBe(phase === "unsafe-updater" ? 1 : 0);
        expect(runtime.exit).toHaveBeenCalledOnce();
        expect(start).toHaveBeenCalledOnce();
        expect(acquireGatewayLock).toHaveBeenCalledOnce();
        expect(respawnGatewayProcessForUpdate).toHaveBeenCalledTimes(stoppingUpdater ? 0 : 1);
        expect(commitManagedServiceUpdateHandoff).not.toHaveBeenCalled();
        expect(markUpdateRestartSentinelFailure).not.toHaveBeenCalled();
        expect(writeGatewayRestartHandoffSync).not.toHaveBeenCalled();
      } finally {
        updater.resolve({ respawn: false });
        readiness.resolve(respawnHealth({ healthy: false, waitOutcome: "stopped-free" }));
        flush.resolve();
        child.exitCode = 0;
        child.emit("exit", 0, null);
        child.emit("close", 0, null);
        await withTimeout(exited, 4_000);
        flushLogger.mockReset().mockResolvedValue(undefined);
      }
    });
  });
}
