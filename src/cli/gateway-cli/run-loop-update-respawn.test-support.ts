/** Registers update replacement and handoff cases in the run-loop signal fixture. */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
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
    readRestartSentinelReadOnly,
    writeRestartSentinelIfUnchanged,
    restartGatewayProcessWithFreshPid,
    withIsolatedSignals,
    createSignaledStart,
    createRuntimeWithExitSignal,
    runLoopWithStart,
    waitForStart,
    waitForLoopCondition,
    createSignaledLoopHarness,
    markUpdateRestartSentinelFailure,
    writeGatewayRestartHandoffSync,
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
    gatewayLog,
    consumeGatewayRestartIntentPayloadSync,
    commitManagedServiceUpdateHandoff,
    setPlatform,
    expectRestartHandoffCall,
    originalPlatformDescriptor,
  } = fixtures;
  it("joins cancellation before restoring unchanged runtime when foreground provider cleanup fails", async () => {
    const cancellation = createDeferred<"restored-in-process">();
    consumeGatewayRestartIntent.mockReturnValueOnce({
      reason: "update.run",
      successorOwner: managedUpdateSuccessorOwner,
    });
    isForegroundUpdateHandoff.mockReturnValue(true);
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
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        if (runtime.exit.mock.calls.length === 0) {
          stop();
        }
        await exited;
      }
    });
  });

  it.each([
    "healthy",
    "unsafe",
    "failed-spawn",
    "disabled",
    "unhealthy",
    "pending",
    "exited",
    "timeout",
    "version-mismatch",
    "channel-errors",
    "generation-changed",
  ] as const)(
    "joins the foreground updater before a fresh successor and never resumes migrated runtime: %s",
    async (outcome) => {
      const updater = createDeferred<{ respawn: boolean }>();
      consumeGatewayRestartIntent.mockReturnValueOnce({
        reason: "update.run",
        successorOwner: managedUpdateSuccessorOwner,
      });
      isForegroundUpdateHandoff.mockReturnValue(true);
      completeForegroundUpdateHandoffAfterClose.mockReturnValueOnce(updater.promise);
      const lockRelease = vi.fn(async () => {});
      acquireGatewayLock.mockResolvedValueOnce({ release: lockRelease });
      const child = createUpdateRespawnChild();
      if (outcome === "exited") {
        child.exitCode = 1;
      }
      const readinessRejected = [
        "unhealthy",
        "timeout",
        "version-mismatch",
        "channel-errors",
        "generation-changed",
      ].includes(outcome);
      const health = respawnHealth({
        healthy: outcome === "healthy" || outcome === "exited" || outcome === "timeout",
        waitOutcome:
          outcome === "healthy" || outcome === "exited"
            ? "healthy"
            : outcome === "pending"
              ? "still-starting"
              : outcome === "version-mismatch" ||
                  outcome === "channel-errors" ||
                  outcome === "generation-changed"
                ? outcome
                : outcome === "timeout"
                  ? "timeout"
                  : "stopped-free",
        ...(outcome === "unhealthy" ? { runtime: { status: "stopped" as const } } : {}),
        ...(outcome === "version-mismatch"
          ? { versionMismatch: { expected: "new", actual: "old" } }
          : {}),
        ...(outcome === "channel-errors"
          ? { channelProbeErrors: [{ id: "synthetic", error: "not ready" }] }
          : {}),
      });
      waitForGatewayHealthyRestart.mockResolvedValueOnce(health);
      const sentinel = {
        version: 1 as const,
        revision: 7,
        payload: {
          kind: "update" as const,
          status: "ok" as const,
          ts: 1,
          sessionKey: "agent:main:main",
          continuation: { kind: "agentTurn" as const, message: "Resume after verified startup." },
          stats: { runId: "00000000-0000-4000-8000-000000000007" },
        },
      };
      readRestartSentinelReadOnly.mockResolvedValueOnce(sentinel);
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
          const consumedIntents = consumeGatewayRestartIntentPayloadSync.mock.calls.length;
          captureSignal("SIGUSR2")();
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
          expect(consumeGatewayRestartIntentPayloadSync).toHaveBeenCalledTimes(consumedIntents);
          updater.resolve({ respawn: outcome !== "unsafe" });
          if (readinessRejected) {
            await waitForLoopCondition(
              () => child.kill.mock.calls.length === 1,
              "rejected foreground successor did not receive termination",
            );
            expect(runtime.exit).not.toHaveBeenCalled();
            expect(gatewayLog.warn).toHaveBeenCalledWith(
              expect.stringContaining("shutdown pending"),
            );
            child.exitCode = 1;
            child.emit("exit", 1, null);
            await new Promise<void>((resolve) => {
              setImmediate(resolve);
            });
            expect(runtime.exit).not.toHaveBeenCalled();
            child.emit("close", 1, null);
          } else if (outcome === "exited") {
            await waitForLoopCondition(
              () => waitForGatewayHealthyRestart.mock.calls.length === 1,
              "foreground successor readiness was not observed",
            );
            await new Promise<void>((resolve) => {
              setImmediate(resolve);
            });
            expect(runtime.exit).not.toHaveBeenCalled();
            child.emit("close", 1, null);
          }
          await expect(withTimeout(exited, 4_000)).resolves.toBe(
            outcome === "healthy" || outcome === "pending" ? 0 : 1,
          );
          expect(start).toHaveBeenCalledOnce();
          expect(acquireGatewayLock).toHaveBeenCalledOnce();
          expect(stopManagedProviderLocalServices).toHaveBeenCalledOnce();
          expect(commitManagedServiceUpdateHandoff).not.toHaveBeenCalled();
          expect(cancelManagedServiceUpdateHandoff).not.toHaveBeenCalled();
          expect(markUpdateRestartSentinelFailure).not.toHaveBeenCalled();
          expect(writeGatewayRestartHandoffSync).not.toHaveBeenCalled();
          if (outcome === "unsafe") {
            expect(respawnGatewayProcessForUpdate).not.toHaveBeenCalled();
          } else {
            expect(respawnGatewayProcessForUpdate).toHaveBeenCalledOnce();
          }
          if (readinessRejected) {
            expect(child.kill).toHaveBeenCalledOnce();
          }
          if (outcome === "healthy" || outcome === "pending") {
            expect(child.kill).not.toHaveBeenCalled();
            expect(child.exitCode).toBeNull();
            expect(child.signalCode).toBeNull();
          }
          if (outcome === "pending") {
            expect(killProcessTree).not.toHaveBeenCalled();
            expect(child.kill).not.toHaveBeenCalled();
            expect(child.listenerCount("exit")).toBe(0);
            expect(writeRestartSentinelIfUnchanged).not.toHaveBeenCalled();
            expect(readRestartSentinelReadOnly).not.toHaveBeenCalled();
          }
          if (outcome === "exited") {
            expect(killProcessTree).not.toHaveBeenCalled();
          }
        } finally {
          child.exitCode = 1;
          child.emit("exit", 1, null);
          child.emit("close", 1, null);
          updater.resolve({ respawn: false });
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
          if (runtime.exit.mock.calls.length === 0) {
            stop();
          }
          await exited;
        }
      });
    },
  );

  it("preserves a real foreground successor after shared readiness reports still-starting", async () => {
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
    const childKill = vi.spyOn(child, "kill");
    killProcessTree.mockImplementation(actualKillTree.killProcessTree);
    try {
      const [parkedMessage] = await withTimeout(parked, 5_000);
      expect(parkedMessage).toBe("parked");
      expect(child.pid).toBeTypeOf("number");
      consumeGatewayRestartIntent.mockReturnValueOnce({
        reason: "update.run",
        successorOwner: managedUpdateSuccessorOwner,
      });
      isForegroundUpdateHandoff.mockReturnValue(true);
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

        expect(killProcessTree).not.toHaveBeenCalled();
        expect(childKill).not.toHaveBeenCalled();
        expect(child.exitCode).toBeNull();
        expect(child.signalCode).toBeNull();
        expect(exitCode).toBe(0);
        expect(gatewayLog.warn).toHaveBeenCalledWith(expect.stringContaining("still starting"));
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
        expect(writeGatewayRestartHandoffSync).not.toHaveBeenCalled();

        const listening = once(child, "message");
        child.send("listen");
        const [listeningMessage] = await withTimeout(listening, 5_000);
        expect(listeningMessage).toBe("listening");
        expect(child.exitCode).toBeNull();
        expect(child.signalCode).toBeNull();
      });
    } finally {
      try {
        await stopChildProcess(child, 5_000);
      } finally {
        killProcessTree.mockReset();
        childKill.mockRestore();
      }
    }
  });

  it("fails the foreground handoff when its successor exits while exit logs are flushing", async () => {
    const flushEntered = createDeferred();
    const releaseFlush = createDeferred();
    const child = createUpdateRespawnChild();
    consumeGatewayRestartIntent.mockReturnValueOnce({
      reason: "update.run",
      successorOwner: managedUpdateSuccessorOwner,
    });
    isForegroundUpdateHandoff.mockReturnValue(true);
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
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
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

  it.each(["update.run", "update.auto"] as const)(
    "writes a handoff before exiting for supervised %s restarts",
    async (reason) => {
      vi.clearAllMocks();
      peekGatewayRestartReason.mockReturnValue(reason);
      restartGatewayProcessWithFreshPid.mockReturnValueOnce({
        mode: "supervised",
      });
      try {
        setPlatform("freebsd");
        process.env.OPENCLAW_SUPERVISOR_MODE = "external";
        await withIsolatedSignals(async ({ captureSignal }) => {
          const { runtime, exited } = await createSignaledLoopHarness();
          const restartSignal = captureSignal("SIGUSR2");

          restartSignal();

          await expect(exited).resolves.toBe(0);
          expect(runtime.exit).toHaveBeenCalledWith(0);
          expectRestartHandoffCall({
            restartKind: "update-process",
            reason,
            supervisorMode: "external",
          });
          expect(respawnGatewayProcessForUpdate).not.toHaveBeenCalled();
        });
      } finally {
        delete process.env.OPENCLAW_SUPERVISOR_MODE;
        if (originalPlatformDescriptor) {
          Object.defineProperty(process, "platform", originalPlatformDescriptor);
        }
      }
    },
  );

  it("falls back in-process when a launchd update handoff fails to spawn", async () => {
    vi.clearAllMocks();
    peekGatewayRestartReason.mockReturnValue("update.run");
    restartGatewayProcessWithFreshPid.mockReturnValueOnce({
      mode: "supervised",
      handoffSpawned: Promise.resolve(false),
    });
    try {
      setPlatform("darwin");
      process.env.OPENCLAW_LAUNCHD_LABEL = "ai.openclaw.gateway";
      await withIsolatedSignals(async ({ captureSignal }) => {
        const { start, runtime, exited } = await createSignaledLoopHarness();
        const restartSignal = captureSignal("SIGUSR2");
        const sigint = captureSignal("SIGINT");

        vi.useFakeTimers();
        restartSignal();
        await vi.advanceTimersByTimeAsync(1500);

        expect(start).toHaveBeenCalledTimes(2);
        expect(runtime.exit).not.toHaveBeenCalled();
        expect(markUpdateRestartSentinelFailure).toHaveBeenCalledWith(
          "restart-handoff-unavailable",
        );

        sigint();
        await expect(exited).resolves.toBe(0);
      });
    } finally {
      vi.useRealTimers();
      delete process.env.OPENCLAW_LAUNCHD_LABEL;
      if (originalPlatformDescriptor) {
        Object.defineProperty(process, "platform", originalPlatformDescriptor);
      }
    }
  });

  it("keeps running when an external update restart handoff cannot be persisted", async () => {
    vi.clearAllMocks();
    peekGatewayRestartReason.mockReturnValue("update.run");
    process.env.OPENCLAW_SUPERVISOR_MODE = "external";
    restartGatewayProcessWithFreshPid.mockReturnValueOnce({
      mode: "supervised",
    });
    writeGatewayRestartHandoffSync.mockReturnValueOnce(null);

    try {
      await withIsolatedSignals(async ({ captureSignal }) => {
        const { start, runtime, exited } = await createSignaledLoopHarness();
        const restartSignal = captureSignal("SIGUSR2");
        const sigint = captureSignal("SIGINT");

        restartSignal();
        await waitForLoopCondition(
          () => start.mock.calls.length === 2,
          "external update handoff failure did not restart in-process",
        );

        expect(runtime.exit).not.toHaveBeenCalled();
        expect(markUpdateRestartSentinelFailure).toHaveBeenCalledWith(
          "restart-handoff-unavailable",
        );

        sigint();
        await expect(exited).resolves.toBe(0);
      });
    } finally {
      delete process.env.OPENCLAW_SUPERVISOR_MODE;
    }
  });
}
