import { setImmediate } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { withTimeout } from "../../infra/fs-safe.js";
import { GATEWAY_SHUTDOWN_TIMEOUT_MS } from "../../infra/gateway-shutdown-budget.js";
import type { GatewayRestartResult } from "../daemon-cli/restart-health.types.js";
import { expectCallCount, withRunLoopCleanup } from "./run-loop-cleanup.test-support.js";
import {
  createActiveWorkSnapshot,
  createLifecycleGate,
  createUpdateRespawnChild,
  advanceWithoutCalls,
  type UpdateRespawnFixtures,
} from "./run-loop.test-support.js";

export function registerForegroundUpdateStopTests({
  waitForGatewayActiveWork: waitForWork,
  requestManagedServiceUpdateHandoffPark: parkUpdate,
  consumeGatewayRestartIntent: consumeRestart,
  managedUpdateSuccessorOwner: updateOwner,
  isForegroundUpdateHandoff: isForeground,
  completeForegroundUpdateHandoffAfterClose: completeUpdate,
  captureForegroundUpdateHandoffStop: captureStop,
  respawnGatewayProcessForUpdate: respawnUpdate,
  hasManagedProviderLocalServices: hasProviderServices,
  stopManagedProviderLocalServices: stopProviderServices,
  cancelManagedServiceUpdateHandoff: cancelUpdate,
  acquireGatewayLock: acquireLock,
  withIsolatedSignals,
  createSignaledLoopHarness,
  waitForLoopCondition,
  consumeGatewayRestartIntentPayload: consumeIntent,
  commitManagedServiceUpdateHandoff: commitUpdate,
  flushLogger,
  waitForGatewayHealthyRestart: waitForHealthy,
  respawnHealth,
  markUpdateRestartSentinelFailure: markRestartFailure,
  writeGatewayRestartHandoff: writeHandoff,
  isGatewayWorkAdmissionClosed: admissionClosed,
}: UpdateRespawnFixtures): void {
  function prepareForegroundHandoff() {
    consumeRestart.mockReturnValueOnce({ reason: "update.run", successorOwner: updateOwner });
    isForeground.mockReturnValue(true);
  }

  async function startStopLoop(close = vi.fn(async () => {}), lockPort?: number) {
    return createSignaledLoopHarness(undefined, false, { close, lockPort });
  }
  function capturedStop() {
    const first = createDeferred<boolean>();
    const retry = createDeferred<boolean>();
    const settle = vi
      .fn<() => Promise<boolean>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(retry.promise);
    return { first, retry, settle };
  }
  function prepareRespawn() {
    prepareForegroundHandoff();
    const updater = createDeferred<{ respawn: boolean }>();
    const child = createUpdateRespawnChild();
    completeUpdate.mockReturnValueOnce(updater.promise);
    respawnUpdate.mockReturnValueOnce({ mode: "spawned", pid: child.pid, child });
    return { updater, child };
  }
  function expectNoSuccessor() {
    expectCallCount(0, completeUpdate, respawnUpdate);
  }
  async function waitForCalls(
    mock: { mock: { calls: readonly unknown[] } },
    count: number,
    message: string,
  ) {
    await waitForLoopCondition(() => mock.mock.calls.length === count, message);
  }
  const waitForClosedWitness = () =>
    waitForCalls(completeUpdate, 1, "foreground updater did not receive its closed witness");

  it.each(["pending-completion", "reject"] as const)(
    "retries the captured foreground Stop operation after %s settlement",
    async (outcome) => {
      const pendingCompletion = outcome === "pending-completion";
      const { first, retry, settle } = capturedStop();
      captureStop.mockReturnValueOnce({ settle, canPark: () => false });
      const releaseLock = vi.fn(async () => {});
      acquireLock.mockResolvedValueOnce({ release: releaseLock });
      if (pendingCompletion) {
        prepareForegroundHandoff();
        completeUpdate.mockResolvedValueOnce("pending");
        cancelUpdate.mockResolvedValueOnce(false);
      }
      await withIsolatedSignals(async ({ captureSignal }) => {
        const { close, start, runtime, exited } = await startStopLoop(
          undefined,
          pendingCompletion ? 18789 : undefined,
        );
        await withRunLoopCleanup(
          async () => {
            captureSignal(pendingCompletion ? "SIGUSR2" : "SIGINT")();
            await waitForCalls(settle, 1, "first Stop did not join the captured owner");
            if (pendingCompletion) {
              expect(releaseLock).toHaveBeenCalledOnce();
              expect(cancelUpdate).toHaveBeenCalledExactlyOnceWith(updateOwner);
            } else {
              captureSignal("SIGINT")();
              expect(settle).toHaveBeenCalledOnce();
              expect(admissionClosed()).toBe(true);
            }
            expect(captureStop).toHaveBeenCalledOnce();
            expect(close).toHaveBeenCalledTimes(pendingCompletion ? 1 : 0);
            expectCallCount(0, runtime.exit, respawnUpdate);
            if (outcome === "reject") {
              first.reject(new Error("fixture ownership inspection unavailable"));
            } else {
              first.resolve(false);
            }
            await setImmediate();
            expect(close).toHaveBeenCalledTimes(pendingCompletion ? 1 : 0);
            expect(runtime.exit).not.toHaveBeenCalled();
            captureSignal("SIGINT")();
            await waitForCalls(settle, 2, "explicit Stop did not retry its captured owner");
            expect(captureStop).toHaveBeenCalledOnce();
            expect(close).toHaveBeenCalledTimes(pendingCompletion ? 1 : 0);
            expect(runtime.exit).not.toHaveBeenCalled();
            retry.resolve(true);
            const exitCode = pendingCompletion ? 1 : 0;
            await expect(withTimeout(exited, 4000)).resolves.toBe(exitCode);
            expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(exitCode);
            expectCallCount(1, close, start, acquireLock);
            expect(respawnUpdate).not.toHaveBeenCalled();
            expect(cancelUpdate).toHaveBeenCalledTimes(pendingCompletion ? 1 : 0);
            if (pendingCompletion) {
              expect(completeUpdate).toHaveBeenCalledExactlyOnceWith(updateOwner);
            }
          },
          async () => {
            first.resolve(true);
            retry.resolve(true);
            if (!runtime.exit.mock.calls.length && settle.mock.calls.length < 2) {
              captureSignal("SIGINT")();
            }
            await withTimeout(exited, 4000);
          },
          "Stop settlement assertion and cleanup failed",
        );
      });
    },
  );

  it.each(["close-deadline", "close-failure-uncertain", "close-failure-confirmed-first"] as const)(
    "preserves foreground Stop rescue after verified park: %s",
    async (scenario) => {
      const { first, retry, settle } = capturedStop();
      const closing = createDeferred();
      const cancellation = createDeferred<false | "restored-in-process">();
      const captured = createDeferred<(identity: typeof updateOwner) => void>();
      let parkReady = false;
      captureStop.mockImplementationOnce(({ onPark }) => {
        captured.resolve(onPark);
        return {
          settle,
          canPark: (identity) =>
            parkReady &&
            identity.handoffId === updateOwner.handoffId &&
            identity.installRoot === updateOwner.installRoot,
        };
      });
      isForeground.mockReturnValue(true);
      cancelUpdate.mockImplementationOnce(() => cancellation.promise);
      await withIsolatedSignals(async ({ captureSignal }) => {
        const close = vi.fn(async () => {
          if (scenario !== "close-deadline") {
            throw new Error("fixture server-close failure");
          }
          await closing.promise;
        });
        const { runtime } = await startStopLoop(close);
        try {
          captureSignal("SIGINT")();
          const onPark = await withTimeout(captured.promise, 4000);
          expectCallCount(0, close, runtime.exit);
          vi.useFakeTimers();
          parkReady = true;
          onPark(updateOwner);
          await vi.advanceTimersByTimeAsync(0);
          expect(close).toHaveBeenCalledOnce();
          expect(parkUpdate).toHaveBeenCalledWith(updateOwner);
          if (scenario === "close-deadline") {
            captureSignal("SIGINT")();
            expect(settle).toHaveBeenCalledOnce();
            await advanceWithoutCalls(GATEWAY_SHUTDOWN_TIMEOUT_MS - 1, cancelUpdate, runtime.exit);
            await vi.advanceTimersByTimeAsync(1);
          }
          expect(cancelUpdate).toHaveBeenCalledExactlyOnceWith(updateOwner);
          expect(runtime.exit).not.toHaveBeenCalled();
          if (scenario === "close-failure-uncertain") {
            cancellation.resolve(false);
            first.resolve(false);
            await advanceWithoutCalls(0, runtime.exit);
            captureSignal("SIGINT")();
            await vi.advanceTimersByTimeAsync(0);
            expect(settle).toHaveBeenCalledTimes(2);
            expect(captureStop).toHaveBeenCalledOnce();
            expect(runtime.exit).not.toHaveBeenCalled();
            retry.resolve(true);
          } else if (scenario === "close-failure-confirmed-first") {
            first.resolve(true);
            await advanceWithoutCalls(0, runtime.exit);
            expect(settle).toHaveBeenCalledOnce();
            cancellation.resolve(false);
          } else {
            cancellation.resolve("restored-in-process");
            first.resolve(true);
          }
          await vi.advanceTimersByTimeAsync(0);
          if (scenario === "close-deadline") {
            expect(runtime.exit).not.toHaveBeenCalled();
            closing.resolve();
            await vi.advanceTimersByTimeAsync(0);
          }
          expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(1);
          expect(close).toHaveBeenCalledOnce();
          expectNoSuccessor();
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
    captureStop.mockReturnValueOnce({ settle, canPark: () => false });
    await withIsolatedSignals(async ({ captureSignal }) => {
      const { close, runtime, exited } = await startStopLoop();
      const restart = await import("../../infra/restart.js");
      const actual =
        await vi.importActual<typeof import("../../infra/restart.js")>("../../infra/restart.js");
      const rollback = vi
        .spyOn(restart, "rollbackGatewayRestartSignalAdmission")
        .mockImplementation(actual.rollbackGatewayRestartSignalAdmission);
      try {
        captureSignal("SIGINT")();
        await waitForCalls(settle, 1, "Stop did not capture its pending owner");
        const reads = consumeIntent.mock.calls.length;
        consumeIntent.mockRejectedValueOnce(new Error("fixture restart intent unavailable"));
        captureSignal("SIGUSR2")();
        await setImmediate();
        await setImmediate();
        expect(consumeIntent).toHaveBeenCalledTimes(reads + 1);
        expect(rollback).not.toHaveBeenCalled();
        expect(admissionClosed()).toBe(true);
        expectCallCount(0, close, runtime.exit);
        expectCallCount(1, settle, captureStop);
        joined.resolve(true);
        await expect(withTimeout(exited, 4000)).resolves.toBe(0);
        expect(runtime.exit).toHaveBeenCalledOnce();
        expect(respawnUpdate).not.toHaveBeenCalled();
      } finally {
        joined.resolve(true);
        rollback.mockRestore();
        await withTimeout(exited, 4000);
      }
    });
  });

  it.each([
    { phase: "parking", signal: "SIGINT" },
    { phase: "provider", signal: "SIGTERM" },
    { phase: "lock-reacquisition", signal: "SIGINT" },
  ] as const)(
    "stops a cancelled foreground handoff during $phase with $signal",
    async ({ phase, signal }) => {
      const cancellation = createLifecycleGate();
      const initialLockRelease = vi.fn(async () => {});
      const restoredLockRelease = vi.fn(async () => {});
      prepareForegroundHandoff();
      if (phase === "parking") {
        parkUpdate.mockResolvedValueOnce(false);
      } else {
        hasProviderServices.mockReturnValue(true);
        stopProviderServices.mockRejectedValueOnce(new Error("provider cleanup failed"));
      }
      cancelUpdate.mockImplementationOnce(async () => {
        if (phase !== "lock-reacquisition") {
          await cancellation.wait();
        }
        isForeground.mockReturnValue(false);
        return "restored-in-process";
      });
      acquireLock.mockResolvedValueOnce({ release: initialLockRelease });
      if (phase === "lock-reacquisition") {
        acquireLock.mockImplementationOnce(async () => {
          await cancellation.wait();
          return { release: restoredLockRelease };
        });
      }
      await withIsolatedSignals(async ({ captureSignal }) => {
        const { start, runtime, exited } = await createSignaledLoopHarness();
        try {
          captureSignal("SIGUSR2")();
          await withTimeout(cancellation.entered, 4_000);
          captureSignal(signal)();
          await setImmediate();
          expect(runtime.exit).not.toHaveBeenCalled();
          expect(start).toHaveBeenCalledOnce();
          cancellation.release();
          await waitForLoopCondition(
            () => runtime.exit.mock.calls.length > 0 || start.mock.calls.length > 1,
            "foreground cancellation did not settle",
          );
          expect(start).toHaveBeenCalledOnce();
          await expect(withTimeout(exited, 4_000)).resolves.toBe(0);
          expect(initialLockRelease).toHaveBeenCalledOnce();
          expect(restoredLockRelease).toHaveBeenCalledTimes(phase === "lock-reacquisition" ? 1 : 0);
          expect(acquireLock).toHaveBeenCalledTimes(phase === "lock-reacquisition" ? 2 : 1);
          expect(cancelUpdate).toHaveBeenCalledExactlyOnceWith(updateOwner);
          expectNoSuccessor();
          expectCallCount(0, commitUpdate);
        } finally {
          cancellation.release();
          await setImmediate();
          if (runtime.exit.mock.calls.length === 0) {
            captureSignal("SIGINT")();
          }
          await withTimeout(exited, 4_000);
        }
      });
    },
  );

  it.each([
    { phase: "drain", signal: "SIGINT", restartIntent: false },
    { phase: "server-close", signal: "SIGTERM", restartIntent: false },
    { phase: "drain", signal: "SIGTERM", restartIntent: true },
  ] as const)(
    "retains pre-close foreground $signal during $phase (restart intent: $restartIntent)",
    async ({ phase, signal, restartIntent }) => {
      const preClose = createLifecycleGate();
      const { updater } = prepareRespawn();
      waitForWork.mockImplementationOnce(async () => {
        if (phase === "drain") {
          await preClose.wait();
        }
        return { drained: true, snapshot: createActiveWorkSnapshot() };
      });
      const close = vi.fn(async () => {
        if (phase === "server-close") {
          await preClose.wait();
        }
      });
      await withIsolatedSignals(async ({ captureSignal }) => {
        const { start, runtime, exited } = await startStopLoop(close, 18789);
        try {
          captureSignal("SIGUSR2")();
          await withTimeout(preClose.entered, 4_000);
          expect(completeUpdate).not.toHaveBeenCalled();
          if (restartIntent) {
            consumeIntent.mockResolvedValueOnce({ reason: "update.run" });
          }
          captureSignal(signal)();
          await setImmediate();
          expectCallCount(0, runtime.exit, respawnUpdate);
          preClose.release();
          await waitForClosedWitness();
          expect(close).toHaveBeenCalledOnce();
          expect(runtime.exit).not.toHaveBeenCalled();
          updater.resolve({ respawn: true });
          await expect(withTimeout(exited, 4_000)).resolves.toBe(0);
          expect(respawnUpdate).toHaveBeenCalledTimes(restartIntent ? 1 : 0);
          expectCallCount(1, start, acquireLock);
          expect(cancelUpdate).not.toHaveBeenCalled();
        } finally {
          preClose.release();
          updater.resolve({ respawn: false });
          await withTimeout(exited, 4_000);
        }
      });
    },
  );

  it.each([
    { phase: "updater", signal: "SIGINT" },
    { phase: "unsafe-updater", signal: "SIGTERM" },
    { phase: "readiness", signal: "SIGTERM" },
    { phase: "log-flush", signal: "SIGINT" },
  ] as const)("retains $signal stop intent during foreground $phase", async ({ signal, phase }) => {
    const { updater, child } = prepareRespawn();
    const readiness = createDeferred<GatewayRestartResult>();
    const flush = createLifecycleGate();
    flushLogger.mockImplementationOnce(flush.wait);
    await withIsolatedSignals(async ({ captureSignal }) => {
      const { start, runtime, exited } = await startStopLoop(undefined, 18789);
      waitForHealthy.mockImplementationOnce(() => readiness.promise);
      const stop = () => captureSignal(signal)();
      try {
        captureSignal("SIGUSR2")();
        await waitForClosedWitness();
        const consumedIntents = consumeIntent.mock.calls.length;
        const stoppingUpdater = phase === "updater" || phase === "unsafe-updater";
        if (!stoppingUpdater) {
          updater.resolve({ respawn: true });
          await waitForCalls(
            waitForHealthy,
            1,
            "fresh Gateway readiness observation did not start",
          );
          if (phase === "log-flush") {
            readiness.resolve(respawnHealth());
            await withTimeout(flush.entered, 4_000);
          }
        }
        stop();
        stop();
        expect(runtime.exit).not.toHaveBeenCalled();
        expect(consumeIntent).toHaveBeenCalledTimes(consumedIntents);
        expect(cancelUpdate).not.toHaveBeenCalled();
        if (stoppingUpdater) {
          expect(respawnUpdate).not.toHaveBeenCalled();
          updater.resolve({ respawn: phase !== "unsafe-updater" });
        } else {
          expect(child.kill).toHaveBeenCalledExactlyOnceWith(signal);
        }
        readiness.resolve(respawnHealth());
        flush.release();
        if (!stoppingUpdater) {
          await setImmediate();
          expect(runtime.exit).not.toHaveBeenCalled();
          child.exitCode = 0;
          child.emit("exit", 0, null);
          await setImmediate();
          expect(runtime.exit).not.toHaveBeenCalled();
          child.emit("close", 0, null);
        }
        await expect(withTimeout(exited, 4_000)).resolves.toBe(phase === "unsafe-updater" ? 1 : 0);
        expectCallCount(1, runtime.exit, start, acquireLock);
        expect(respawnUpdate).toHaveBeenCalledTimes(stoppingUpdater ? 0 : 1);
        expectCallCount(0, commitUpdate, markRestartFailure, writeHandoff);
      } finally {
        updater.resolve({ respawn: false });
        readiness.resolve(respawnHealth({ healthy: false, waitOutcome: "stopped-free" }));
        flush.release();
        child.exitCode = 0;
        child.emit("exit", 0, null);
        child.emit("close", 0, null);
        await withTimeout(exited, 4_000);
        flushLogger.mockReset().mockResolvedValue(undefined);
      }
    });
  });
}
