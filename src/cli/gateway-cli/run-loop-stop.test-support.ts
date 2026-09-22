import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { withTimeout } from "../../infra/fs-safe.js";
import { GATEWAY_SHUTDOWN_TIMEOUT_MS } from "../../infra/gateway-shutdown-budget.js";
import type { GatewayRestartSnapshot } from "../daemon-cli/restart-health.js";
import {
  createActiveWorkSnapshot,
  createUpdateRespawnChild,
  type UpdateRespawnFixtures,
} from "./run-loop.test-support.js";

export function registerForegroundUpdateStopTests({
  waitForGatewayActiveWork,
  requestManagedServiceUpdateHandoffPark,
  consumeGatewayRestartIntent,
  managedUpdateSuccessorOwner,
  isForegroundUpdateHandoff,
  completeForegroundUpdateHandoffAfterClose,
  captureForegroundUpdateHandoffStop,
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
  it("retains pending foreground completion until Stop retries the captured settlement", async () => {
    const first = createDeferred<boolean>();
    const retry = createDeferred<boolean>();
    const settle = vi
      .fn<() => Promise<boolean>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(retry.promise);
    captureForegroundUpdateHandoffStop.mockReturnValueOnce({ settle, canPark: () => false });
    consumeGatewayRestartIntent.mockReturnValueOnce({
      reason: "update.run",
      successorOwner: managedUpdateSuccessorOwner,
    });
    isForegroundUpdateHandoff.mockReturnValue(true);
    completeForegroundUpdateHandoffAfterClose.mockResolvedValueOnce("pending");
    cancelManagedServiceUpdateHandoff.mockResolvedValueOnce(false);
    const releaseLock = vi.fn(async () => {});
    acquireGatewayLock.mockResolvedValueOnce({ release: releaseLock });
    await withIsolatedSignals(async ({ captureSignal }) => {
      const close = vi.fn(async () => {});
      const { start, started } = createSignaledStart(close);
      const { runtime, exited } = createRuntimeWithExitSignal();
      const failures: unknown[] = [];
      try {
        await runLoopWithStart({ start, runtime, lockPort: 18789 });
        await waitForStart(started);
        captureSignal("SIGUSR2")();
        await waitForLoopCondition(
          () => settle.mock.calls.length === 1,
          "pending foreground completion did not reconcile its captured helper",
        );
        expect(close).toHaveBeenCalledOnce();
        expect(releaseLock).toHaveBeenCalledOnce();
        expect(cancelManagedServiceUpdateHandoff).toHaveBeenCalledExactlyOnceWith(
          managedUpdateSuccessorOwner,
        );
        expect(captureForegroundUpdateHandoffStop).toHaveBeenCalledOnce();
        expect(runtime.exit).not.toHaveBeenCalled();
        expect(respawnGatewayProcessForUpdate).not.toHaveBeenCalled();
        first.resolve(false);
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(runtime.exit).not.toHaveBeenCalled();
        captureSignal("SIGINT")();
        await waitForLoopCondition(
          () => settle.mock.calls.length === 2,
          "Stop did not retry the original pending completion owner",
        );
        expect(captureForegroundUpdateHandoffStop).toHaveBeenCalledOnce();
        expect(cancelManagedServiceUpdateHandoff).toHaveBeenCalledOnce();
        expect(runtime.exit).not.toHaveBeenCalled();
        retry.resolve(true);
        await expect(withTimeout(exited, 4000)).resolves.toBe(1);
        expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(1);
        expect(close).toHaveBeenCalledOnce();
        expect(start).toHaveBeenCalledOnce();
        expect(acquireGatewayLock).toHaveBeenCalledOnce();
        expect(completeForegroundUpdateHandoffAfterClose).toHaveBeenCalledExactlyOnceWith(
          managedUpdateSuccessorOwner,
        );
        expect(respawnGatewayProcessForUpdate).not.toHaveBeenCalled();
      } catch (error) {
        failures.push(error);
      }
      try {
        first.resolve(true);
        retry.resolve(true);
        if (!runtime.exit.mock.calls.length && settle.mock.calls.length < 2) {
          captureSignal("SIGINT")();
        }
        await withTimeout(exited, 4000);
      } catch (error) {
        failures.push(error);
      }
      if (failures.length > 1) {
        throw new AggregateError(failures, "Pending completion assertion and cleanup failed", {
          cause: failures[0],
        });
      }
      if (failures.length === 1) {
        throw failures[0];
      }
    });
  });

  it.each(["close-deadline", "close-failure-uncertain", "close-failure-confirmed-first"] as const)(
    "preserves foreground Stop rescue after verified park: %s",
    async (scenario) => {
      const first = createDeferred<boolean>();
      const retry = createDeferred<boolean>();
      const closing = createDeferred();
      const cancellation = createDeferred<false | "restored-in-process">();
      const captured = createDeferred<(identity: typeof managedUpdateSuccessorOwner) => void>();
      let parkReady = false;
      const settle = vi
        .fn<() => Promise<boolean>>()
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(retry.promise);
      captureForegroundUpdateHandoffStop.mockImplementationOnce(({ onPark }) => {
        captured.resolve(onPark);
        return {
          settle,
          canPark: (identity) =>
            parkReady &&
            identity.handoffId === managedUpdateSuccessorOwner.handoffId &&
            identity.installRoot === managedUpdateSuccessorOwner.installRoot,
        };
      });
      isForegroundUpdateHandoff.mockReturnValue(true);
      cancelManagedServiceUpdateHandoff.mockImplementationOnce(() => cancellation.promise);
      await withIsolatedSignals(async ({ captureSignal }) => {
        const close = vi.fn(async () => {
          if (scenario !== "close-deadline") {
            throw new Error("fixture server-close failure");
          }
          await closing.promise;
        });
        const { start, started } = createSignaledStart(close);
        const { runtime } = createRuntimeWithExitSignal();
        try {
          await runLoopWithStart({ start, runtime });
          await waitForStart(started);
          captureSignal("SIGINT")();
          const onPark = await withTimeout(captured.promise, 4000);
          expect(close).not.toHaveBeenCalled();
          expect(runtime.exit).not.toHaveBeenCalled();
          vi.useFakeTimers();
          parkReady = true;
          onPark(managedUpdateSuccessorOwner);
          await vi.advanceTimersByTimeAsync(0);
          expect(close).toHaveBeenCalledOnce();
          expect(requestManagedServiceUpdateHandoffPark).toHaveBeenCalledWith(
            managedUpdateSuccessorOwner,
          );
          if (scenario === "close-deadline") {
            captureSignal("SIGINT")();
            expect(settle).toHaveBeenCalledOnce();
            await vi.advanceTimersByTimeAsync(GATEWAY_SHUTDOWN_TIMEOUT_MS - 1);
            expect(cancelManagedServiceUpdateHandoff).not.toHaveBeenCalled();
            expect(runtime.exit).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(1);
          }
          expect(cancelManagedServiceUpdateHandoff).toHaveBeenCalledExactlyOnceWith(
            managedUpdateSuccessorOwner,
          );
          expect(runtime.exit).not.toHaveBeenCalled();
          if (scenario === "close-failure-uncertain") {
            cancellation.resolve(false);
            first.resolve(false);
            await vi.advanceTimersByTimeAsync(0);
            expect(runtime.exit).not.toHaveBeenCalled();
            captureSignal("SIGINT")();
            await vi.advanceTimersByTimeAsync(0);
            expect(settle).toHaveBeenCalledTimes(2);
            expect(captureForegroundUpdateHandoffStop).toHaveBeenCalledOnce();
            expect(runtime.exit).not.toHaveBeenCalled();
            retry.resolve(true);
          } else if (scenario === "close-failure-confirmed-first") {
            first.resolve(true);
            await vi.advanceTimersByTimeAsync(0);
            expect(runtime.exit).not.toHaveBeenCalled();
            expect(settle).toHaveBeenCalledOnce();
            cancellation.resolve(false);
          } else {
            cancellation.resolve("restored-in-process");
            first.resolve(true);
          }
          await vi.advanceTimersByTimeAsync(0);
          expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(1);
          expect(close).toHaveBeenCalledOnce();
          expect(respawnGatewayProcessForUpdate).not.toHaveBeenCalled();
          expect(completeForegroundUpdateHandoffAfterClose).not.toHaveBeenCalled();
        } finally {
          closing.resolve();
          cancellation.resolve("restored-in-process");
          first.resolve(true);
          retry.resolve(true);
          if (vi.isFakeTimers()) {
            await vi.advanceTimersByTimeAsync(0);
          }
          vi.clearAllTimers();
          vi.useRealTimers();
        }
      });
    },
  );

  it("preserves pending Stop admission when SIGUSR2 intent reading fails", async () => {
    const joined = createDeferred<boolean>();
    const settle = vi.fn(() => joined.promise);
    captureForegroundUpdateHandoffStop.mockReturnValueOnce({ settle, canPark: () => false });
    await withIsolatedSignals(async ({ captureSignal }) => {
      const close = vi.fn(async () => {});
      const { start, started } = createSignaledStart(close);
      const { runtime, exited } = createRuntimeWithExitSignal();
      await runLoopWithStart({ start, runtime });
      await waitForStart(started);
      const restart = await import("../../infra/restart.js");
      const actual =
        await vi.importActual<typeof import("../../infra/restart.js")>("../../infra/restart.js");
      const rollback = vi
        .spyOn(restart, "rollbackGatewayRestartSignalAdmission")
        .mockImplementation(actual.rollbackGatewayRestartSignalAdmission);
      try {
        captureSignal("SIGINT")();
        await waitForLoopCondition(
          () => settle.mock.calls.length === 1,
          "Stop did not capture its pending owner",
        );
        const reads = consumeGatewayRestartIntentPayloadSync.mock.calls.length;
        consumeGatewayRestartIntentPayloadSync.mockImplementationOnce(() => {
          throw new Error("fixture restart intent unavailable");
        });
        captureSignal("SIGUSR2")();
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(consumeGatewayRestartIntentPayloadSync).toHaveBeenCalledTimes(reads + 1);
        expect(rollback).not.toHaveBeenCalled();
        expect(isGatewayWorkAdmissionClosed()).toBe(true);
        expect(close).not.toHaveBeenCalled();
        expect(runtime.exit).not.toHaveBeenCalled();
        expect(settle).toHaveBeenCalledOnce();
        expect(captureForegroundUpdateHandoffStop).toHaveBeenCalledOnce();
        joined.resolve(true);
        await expect(withTimeout(exited, 4000)).resolves.toBe(0);
        expect(runtime.exit).toHaveBeenCalledOnce();
        expect(respawnGatewayProcessForUpdate).not.toHaveBeenCalled();
      } finally {
        joined.resolve(true);
        rollback.mockRestore();
        await withTimeout(exited, 4000);
      }
    });
  });

  it.each(["false", "reject"] as const)(
    "retries the captured foreground Stop operation after %s settlement",
    async (outcome) => {
      const first = createDeferred<boolean>();
      const second = createDeferred<boolean>();
      const settle = vi
        .fn<() => Promise<boolean>>()
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise);
      captureForegroundUpdateHandoffStop.mockReturnValueOnce({ settle, canPark: () => false });
      await withIsolatedSignals(async ({ captureSignal }) => {
        const close = vi.fn(async () => {});
        const { start, started } = createSignaledStart(close);
        const { runtime, exited } = createRuntimeWithExitSignal();
        const failures: unknown[] = [];
        try {
          await runLoopWithStart({ start, runtime });
          await waitForStart(started);
          captureSignal("SIGINT")();
          await waitForLoopCondition(
            () => settle.mock.calls.length === 1,
            "first Stop did not join the captured owner",
          );
          captureSignal("SIGINT")();
          expect(settle).toHaveBeenCalledOnce();
          expect(captureForegroundUpdateHandoffStop).toHaveBeenCalledOnce();
          expect(isGatewayWorkAdmissionClosed()).toBe(true);
          expect(close).not.toHaveBeenCalled();
          expect(runtime.exit).not.toHaveBeenCalled();
          if (outcome === "reject") {
            first.reject(new Error("fixture ownership inspection unavailable"));
          } else {
            first.resolve(false);
          }
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
          expect(close).not.toHaveBeenCalled();
          expect(runtime.exit).not.toHaveBeenCalled();
          captureSignal("SIGINT")();
          await waitForLoopCondition(
            () => settle.mock.calls.length === 2,
            "explicit Stop did not retry its captured owner",
          );
          expect(captureForegroundUpdateHandoffStop).toHaveBeenCalledOnce();
          expect(close).not.toHaveBeenCalled();
          expect(runtime.exit).not.toHaveBeenCalled();
          second.resolve(true);
          await expect(withTimeout(exited, 4000)).resolves.toBe(0);
          expect(close).toHaveBeenCalledOnce();
          expect(runtime.exit).toHaveBeenCalledOnce();
          expect(respawnGatewayProcessForUpdate).not.toHaveBeenCalled();
          expect(cancelManagedServiceUpdateHandoff).not.toHaveBeenCalled();
        } catch (error) {
          failures.push(error);
        }
        try {
          first.resolve(true);
          second.resolve(true);
          if (!runtime.exit.mock.calls.length && settle.mock.calls.length < 2) {
            captureSignal("SIGINT")();
          }
          await withTimeout(exited, 4000);
        } catch (error) {
          failures.push(error);
        }
        if (failures.length > 1) {
          throw new AggregateError(
            failures,
            "Foreground Stop retry assertion and fixture cleanup failed",
            { cause: failures[0] },
          );
        }
        if (failures.length === 1) {
          throw failures[0];
        }
      });
    },
  );

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
      consumeGatewayRestartIntent.mockReturnValueOnce({
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
          captureSignal("SIGUSR2")();
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
      consumeGatewayRestartIntent.mockReturnValueOnce({
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
          captureSignal("SIGUSR2")();
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
    consumeGatewayRestartIntent.mockReturnValueOnce({
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
        captureSignal("SIGUSR2")();
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
