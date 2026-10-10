/** Registers update replacement and handoff cases in the run-loop signal fixture. */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setImmediate } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { stopChildProcess } from "../../../test/helpers/stop-child-process.js";
import { withTimeout } from "../../infra/fs-safe.js";
import { getFreePort } from "../../test-utils/ports.js";
import { registerPackageLifecycleStopTests } from "./run-loop-package-lifecycle.test-support.js";
import { registerForegroundUpdateStopTests } from "./run-loop-stop.test-support.js";
import { createUpdateRespawnChild, type UpdateRespawnFixtures } from "./run-loop.test-support.js";

export function registerUpdateRespawnTests(fixtures: UpdateRespawnFixtures): void {
  registerForegroundUpdateStopTests(fixtures);
  registerPackageLifecycleStopTests(fixtures);
  const {
    peekGatewayRestartReason,
    respawnGatewayProcessForUpdate,
    waitForGatewayHealthyRestart,
    respawnHealth,
    restartGatewayProcessWithFreshPid,
    withIsolatedSignals,
    createSignaledStart,
    createRuntimeWithExitSignal,
    runLoopWithStart,
    waitForStart,
    waitForLoopCondition,
    createSignaledLoopHarness,
    markUpdateRestartSentinelFailure,
    writeGatewayRestartHandoff,
    consumeGatewayRestartIntent,
    managedUpdateSuccessorOwner,
    isForegroundUpdateHandoff,
    hasManagedProviderLocalServices,
    stopManagedProviderLocalServices,
    cancelManagedServiceUpdateHandoff,
    acquireGatewayLock,
    completeForegroundUpdateHandoffAfterClose,
    killProcessTree,
    flushLogger,
    consumeGatewayRestartIntentPayload,
    commitManagedServiceUpdateHandoff,
    setPlatform,
    originalPlatformDescriptor,
  } = fixtures;

  function prepareForegroundHandoff() {
    consumeGatewayRestartIntent.mockReturnValueOnce({
      reason: "update.run",
      successorOwner: managedUpdateSuccessorOwner,
    });
    isForegroundUpdateHandoff.mockReturnValue(true);
  }

  it("joins cancellation before restoring unchanged runtime when foreground provider cleanup fails", async () => {
    const cancellation = createDeferred<"restored-in-process">();
    prepareForegroundHandoff();
    hasManagedProviderLocalServices.mockReturnValue(true);
    stopManagedProviderLocalServices.mockRejectedValueOnce(new Error("provider cleanup failed"));
    cancelManagedServiceUpdateHandoff.mockReturnValueOnce(cancellation.promise);
    const lockRelease = vi.fn(async () => {});
    acquireGatewayLock.mockResolvedValueOnce({ release: lockRelease });
    await withIsolatedSignals(async ({ captureSignal }) => {
      const { start, runtime, exited } = await createSignaledLoopHarness();
      const stop = captureSignal("SIGINT");
      try {
        captureSignal("SIGUSR2")();
        await waitForLoopCondition(
          () => cancelManagedServiceUpdateHandoff.mock.calls.length === 1,
          "failed provider cleanup did not cancel its updater",
        );
        expect(lockRelease).not.toHaveBeenCalled();
        expect(start).toHaveBeenCalledOnce();
        expect(completeForegroundUpdateHandoffAfterClose).not.toHaveBeenCalled();
        expect(respawnGatewayProcessForUpdate).not.toHaveBeenCalled();
        expect(runtime.exit).not.toHaveBeenCalled();
        cancellation.resolve("restored-in-process");
        await waitForLoopCondition(
          () => start.mock.calls.length === 2,
          "cancelled update did not restore the unchanged Gateway",
        );
        expect(cancelManagedServiceUpdateHandoff).toHaveBeenCalledExactlyOnceWith(
          managedUpdateSuccessorOwner,
        );
        expect(lockRelease).toHaveBeenCalledOnce();
        expect(acquireGatewayLock).toHaveBeenCalledTimes(2);
        expect(completeForegroundUpdateHandoffAfterClose).not.toHaveBeenCalled();
        expect(markUpdateRestartSentinelFailure).toHaveBeenCalledWith(
          "restart-local-service-stop-failed",
        );
        stop();
        await expect(exited).resolves.toBe(0);
      } finally {
        cancellation.resolve("restored-in-process");
        await setImmediate();
        if (runtime.exit.mock.calls.length === 0) {
          stop();
        }
        await exited;
      }
    });
  });

  it.each(["failed-spawn", "disabled", "unhealthy"] as const)(
    "joins the foreground updater before a fresh successor and never resumes migrated runtime: %s",
    async (outcome) => {
      const updater = createDeferred<{ respawn: boolean }>();
      prepareForegroundHandoff();
      completeForegroundUpdateHandoffAfterClose.mockReturnValueOnce(updater.promise);
      const lockRelease = vi.fn(async () => {});
      acquireGatewayLock.mockResolvedValueOnce({ release: lockRelease });
      const child = createUpdateRespawnChild();
      const readinessRejected = outcome === "unhealthy";
      const health = respawnHealth({
        healthy: false,
        waitOutcome: "stopped-free",
        ...(outcome === "unhealthy" ? { runtime: { status: "stopped" as const } } : {}),
      });
      waitForGatewayHealthyRestart.mockResolvedValueOnce(health);
      killProcessTree.mockClear();
      respawnGatewayProcessForUpdate.mockReturnValueOnce(
        outcome === "failed-spawn"
          ? { mode: "failed", detail: "fixture failure" }
          : outcome === "disabled"
            ? { mode: "disabled" }
            : { mode: "spawned", pid: 7777, child },
      );
      hasManagedProviderLocalServices.mockReturnValue(true);
      await withIsolatedSignals(async ({ captureSignal }) => {
        const close = vi.fn(async () => {});
        const { start, started } = createSignaledStart(close);
        const { runtime, exited } = createRuntimeWithExitSignal();
        await runLoopWithStart({ start, runtime, lockPort: 18789 });
        await waitForStart(started);
        const stop = captureSignal("SIGINT");
        try {
          captureSignal("SIGUSR2")();
          await waitForLoopCondition(
            () => completeForegroundUpdateHandoffAfterClose.mock.calls.length === 1,
            "foreground updater did not receive its closed witness",
          );
          expect(close).toHaveBeenCalledOnce();
          expect(lockRelease).toHaveBeenCalledOnce();
          expect(stopManagedProviderLocalServices).toHaveBeenCalledOnce();
          expect(respawnGatewayProcessForUpdate).not.toHaveBeenCalled();
          expect(runtime.exit).not.toHaveBeenCalled();
          const consumedIntents = consumeGatewayRestartIntentPayload.mock.calls.length;
          captureSignal("SIGUSR2")();
          await setImmediate();
          expect(consumeGatewayRestartIntentPayload).toHaveBeenCalledTimes(consumedIntents);
          updater.resolve({ respawn: true });
          if (readinessRejected) {
            await waitForLoopCondition(
              () => child.kill.mock.calls.length === 1,
              "rejected foreground successor did not receive termination",
            );
            expect(runtime.exit).not.toHaveBeenCalled();
            child.exitCode = 1;
            child.emit("exit", 1, null);
            await setImmediate();
            expect(runtime.exit).not.toHaveBeenCalled();
            child.emit("close", 1, null);
          }
          await expect(withTimeout(exited, 4_000)).resolves.toBe(1);
          expect(start).toHaveBeenCalledOnce();
          expect(acquireGatewayLock).toHaveBeenCalledOnce();
          expect(stopManagedProviderLocalServices).toHaveBeenCalledOnce();
          expect(commitManagedServiceUpdateHandoff).not.toHaveBeenCalled();
          expect(cancelManagedServiceUpdateHandoff).not.toHaveBeenCalled();
          expect(markUpdateRestartSentinelFailure).not.toHaveBeenCalled();
          expect(writeGatewayRestartHandoff).not.toHaveBeenCalled();
          expect(respawnGatewayProcessForUpdate).toHaveBeenCalledOnce();
          if (readinessRejected) {
            expect(child.kill).toHaveBeenCalledOnce();
          }
        } finally {
          child.exitCode = 1;
          child.emit("exit", 1, null);
          child.emit("close", 1, null);
          updater.resolve({ respawn: false });
          await setImmediate();
          if (runtime.exit.mock.calls.length === 0) {
            stop();
          }
          await exited;
        }
      });
    },
  );

  it("preserves a real foreground successor after shared readiness reports still-starting", async ({
    signal,
  }) => {
    const actualKillTree = await vi.importActual<typeof import("../../process/kill-tree.js")>(
      "../../process/kill-tree.js",
    );
    const port = await getFreePort();
    const child = spawn(
      process.execPath,
      [
        "--input-type=commonjs",
        "-e",
        `const net = require("node:net");
process.once("message", () => {
  net.createServer(socket => socket.end()).listen(Number(process.argv[1]), "127.0.0.1", () => {
    process.send("listening");
  });
});
process.send("parked");`,
        String(port),
      ],
      { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] },
    );
    const parked = once(child, "message");
    const closed = once(child, "close");
    void closed.catch(() => {});
    killProcessTree.mockImplementation(actualKillTree.killProcessTree);
    try {
      const [parkedMessage] = await withinTest(
        awaitGateBeforeSettlement(parked, closed, "foreground successor did not park"),
        signal,
      );
      expect(parkedMessage).toBe("parked");
      prepareForegroundHandoff();
      respawnGatewayProcessForUpdate.mockReturnValueOnce({
        mode: "spawned",
        pid: child.pid,
        child,
      });
      await withIsolatedSignals(async ({ captureSignal }) => {
        const close = vi.fn(async () => {});
        const { start, started } = createSignaledStart(close);
        const { runtime, exited } = createRuntimeWithExitSignal();
        const completeBoot = vi.fn();
        await runLoopWithStart({ start, runtime, lockPort: port, completeBoot });
        await waitForStart(started);
        waitForGatewayHealthyRestart.mockImplementationOnce(async (params) => {
          expect(params.child).toBe(child);
          expect(child.exitCode).toBeNull();
          return respawnHealth({
            healthy: false,
            waitOutcome: "still-starting",
            runtime: { status: "running", pid: child.pid },
          });
        });
        captureSignal("SIGUSR2")();
        const exitCode = await withTimeout(exited, 20_000);

        expect(exitCode).toBe(0);
        expect(completeBoot).toHaveBeenCalledExactlyOnceWith({
          outcome: "planned_restart",
          reason: "restart (SIGUSR2: update.run)",
        });
        expect(start).toHaveBeenCalledOnce();
        expect(close).toHaveBeenCalledOnce();
        expect(acquireGatewayLock).toHaveBeenCalledOnce();
        expect(cancelManagedServiceUpdateHandoff).not.toHaveBeenCalled();
        expect(commitManagedServiceUpdateHandoff).not.toHaveBeenCalled();
        expect(markUpdateRestartSentinelFailure).not.toHaveBeenCalled();
        expect(writeGatewayRestartHandoff).not.toHaveBeenCalled();

        const listening = once(child, "message");
        child.send("listen");
        const [listeningMessage] = await withinTest(
          awaitGateBeforeSettlement(listening, closed, "foreground successor did not listen"),
          signal,
        );
        expect(listeningMessage).toBe("listening");
        expect(child.exitCode).toBeNull();
        expect(child.signalCode).toBeNull();
      });
    } finally {
      try {
        await stopChildProcess(child, 5_000);
      } finally {
        killProcessTree.mockReset();
      }
    }
  });

  it("fails the foreground handoff when its successor exits while exit logs are flushing", async () => {
    const flushEntered = createDeferred();
    const releaseFlush = createDeferred();
    const child = createUpdateRespawnChild();
    prepareForegroundHandoff();
    respawnGatewayProcessForUpdate.mockReturnValueOnce({ mode: "spawned", pid: child.pid, child });
    flushLogger.mockImplementationOnce(async () => {
      flushEntered.resolve();
      await releaseFlush.promise;
    });
    await withIsolatedSignals(async ({ captureSignal }) => {
      const { start, started } = createSignaledStart(vi.fn(async () => {}));
      const { runtime, exited } = createRuntimeWithExitSignal();
      try {
        await runLoopWithStart({
          start,
          runtime,
          lockPort: 18789,
        });
        await waitForStart(started);
        captureSignal("SIGUSR2")();
        await withTimeout(flushEntered.promise, 5_000);
        expect(runtime.exit).not.toHaveBeenCalled();
        child.exitCode = 1;
        child.emit("exit", 1, null);
        releaseFlush.resolve();
        await setImmediate();
        expect(runtime.exit).not.toHaveBeenCalled();
        child.emit("close", 1, null);
        await expect(withTimeout(exited, 5_000)).resolves.toBe(1);
        expect(start).toHaveBeenCalledOnce();
        expect(acquireGatewayLock).toHaveBeenCalledOnce();
        expect(child.kill).not.toHaveBeenCalled();
        expect(killProcessTree).not.toHaveBeenCalled();
        expect(cancelManagedServiceUpdateHandoff).not.toHaveBeenCalled();
        expect(commitManagedServiceUpdateHandoff).not.toHaveBeenCalled();
        expect(markUpdateRestartSentinelFailure).not.toHaveBeenCalled();
      } finally {
        releaseFlush.resolve();
        child.emit("close", 1, null);
        await withTimeout(exited, 5_000);
        flushLogger.mockReset().mockResolvedValue(undefined);
      }
    });
  });

  it.each([
    { name: "a launchd update handoff fails to spawn", launchd: true },
    { name: "an external update restart handoff cannot be persisted", launchd: false },
  ])("falls back in-process when $name", async ({ launchd }) => {
    vi.clearAllMocks();
    peekGatewayRestartReason.mockReturnValue("update.run");
    restartGatewayProcessWithFreshPid.mockReturnValueOnce({
      mode: "supervised",
      ...(launchd ? { handoffSpawned: Promise.resolve(false) } : {}),
    });
    if (!launchd) {
      writeGatewayRestartHandoff.mockResolvedValueOnce(null);
    }
    try {
      if (launchd) {
        setPlatform("darwin");
        process.env.OPENCLAW_LAUNCHD_LABEL = "ai.openclaw.gateway";
      } else {
        process.env.OPENCLAW_SUPERVISOR_MODE = "external";
      }
      await withIsolatedSignals(async ({ captureSignal }) => {
        const { start, runtime, exited } = await createSignaledLoopHarness();
        if (launchd) {
          vi.useFakeTimers();
        }
        captureSignal("SIGUSR2")();
        if (launchd) {
          await vi.advanceTimersByTimeAsync(1500);
        } else {
          await waitForLoopCondition(
            () => start.mock.calls.length === 2,
            "external update handoff failure did not restart in-process",
          );
        }
        expect(start).toHaveBeenCalledTimes(2);
        expect(runtime.exit).not.toHaveBeenCalled();
        expect(markUpdateRestartSentinelFailure).toHaveBeenCalledWith(
          "restart-handoff-unavailable",
        );
        captureSignal("SIGINT")();
        await expect(exited).resolves.toBe(0);
      });
    } finally {
      vi.useRealTimers();
      delete process.env.OPENCLAW_LAUNCHD_LABEL;
      delete process.env.OPENCLAW_SUPERVISOR_MODE;
      if (originalPlatformDescriptor) {
        Object.defineProperty(process, "platform", originalPlatformDescriptor);
      }
    }
  });
}
