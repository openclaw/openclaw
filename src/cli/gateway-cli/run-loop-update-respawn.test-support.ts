import { spawn } from "node:child_process";
import { once } from "node:events";
import { setImmediate } from "node:timers/promises";
import { expect, it, vi, type MockInstance } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { stopChildProcess } from "../../../test/helpers/stop-child-process.js";
import { withTimeout } from "../../infra/fs-safe.js";
import { getFreePort } from "../../test-utils/ports.js";
import { expectCallCount } from "./run-loop-cleanup.test-support.js";
import { registerPackageLifecycleStopTests } from "./run-loop-package-lifecycle.test-support.js";
import { registerForegroundUpdateStopTests } from "./run-loop-stop.test-support.js";
import {
  createUpdateRespawnChild,
  expectUncalled,
  type UpdateRespawnFixtures,
} from "./run-loop.test-support.js";

export function registerUpdateRespawnTests(f: UpdateRespawnFixtures): void {
  const {
    respawnGatewayProcessForUpdate: respawn,
    cancelManagedServiceUpdateHandoff: cancelUpdate,
    commitManagedServiceUpdateHandoff: commitUpdate,
    markUpdateRestartSentinelFailure: markFailure,
    completeForegroundUpdateHandoffAfterClose: completeUpdate,
  } = f;
  registerForegroundUpdateStopTests(f);
  registerPackageLifecycleStopTests(f);
  type Loop = Parameters<Parameters<typeof f.withRunningGateway>[0]>[0];

  function prepareForegroundHandoff() {
    f.consumeGatewayRestartIntent.mockReturnValueOnce({
      reason: "update.run",
      successorOwner: f.managedUpdateSuccessorOwner,
    });
    f.isForegroundUpdateHandoff.mockReturnValue(true);
  }

  const waitForCalls = (mock: MockInstance, count = 1) =>
    f.waitForLoopCondition(() => mock.mock.calls.length === count, `expected ${count} calls`);

  async function withForeground(
    run: (loop: Loop) => Promise<void>,
    release: (loop: Loop) => void | Promise<void>,
  ) {
    prepareForegroundHandoff();
    await f.withRunningGateway(
      async (loop) => {
        try {
          await run(loop);
        } finally {
          await release(loop);
          await setImmediate();
          if (loop.runtime.exit.mock.calls.length === 0) {
            loop.captureSignal("SIGINT")();
          }
          await loop.exited;
        }
      },
      false,
      { lockPort: 18789 },
    );
  }

  it("joins failed provider cleanup cancellation before restoring the runtime", async () => {
    const cancellation = createDeferred<"restored-in-process">();
    f.hasManagedProviderLocalServices.mockReturnValue(true);
    f.stopManagedProviderLocalServices.mockRejectedValueOnce(new Error("provider cleanup failed"));
    cancelUpdate.mockReturnValueOnce(cancellation.promise);
    const lockRelease = vi.fn(async () => {});
    f.acquireGatewayLock.mockResolvedValueOnce({ release: lockRelease });
    await withForeground(
      async ({ captureSignal, start, runtime, exited }) => {
        captureSignal("SIGUSR2")();
        await waitForCalls(cancelUpdate);
        expectUncalled(lockRelease, completeUpdate, respawn, runtime.exit);
        expect(start).toHaveBeenCalledOnce();
        cancellation.resolve("restored-in-process");
        await waitForCalls(start, 2);
        expect(cancelUpdate).toHaveBeenCalledExactlyOnceWith(f.managedUpdateSuccessorOwner);
        expect(lockRelease).toHaveBeenCalledOnce();
        expect(completeUpdate).not.toHaveBeenCalled();
        expect(markFailure).toHaveBeenCalledWith("restart-local-service-stop-failed");
        captureSignal("SIGINT")();
        await expect(exited).resolves.toBe(0);
      },
      () => cancellation.resolve("restored-in-process"),
    );
  });

  it.each(["failed-spawn", "disabled", "unhealthy", "exit-during-flush"] as const)(
    "never resumes migrated runtime after %s",
    async (outcome) => {
      const updater = createDeferred<{ respawn: boolean }>();
      completeUpdate.mockReturnValueOnce(updater.promise);
      const lockRelease = vi.fn(async () => {});
      f.acquireGatewayLock.mockResolvedValueOnce({ release: lockRelease });
      const child = createUpdateRespawnChild();
      const readinessRejected = outcome === "unhealthy";
      const lateExit = outcome === "exit-during-flush";
      const flushEntered = createDeferred();
      const releaseFlush = createDeferred();
      if (lateExit) {
        f.flushLogger.mockImplementationOnce(async () => {
          flushEntered.resolve();
          await releaseFlush.promise;
        });
      } else {
        f.waitForGatewayHealthyRestart.mockResolvedValueOnce(
          f.respawnHealth({
            healthy: false,
            waitOutcome: "stopped-free",
            ...(readinessRejected ? { runtime: { status: "stopped" as const } } : {}),
          }),
        );
      }
      respawn.mockReturnValueOnce(
        outcome === "failed-spawn"
          ? { mode: "failed", detail: "fixture failure" }
          : outcome === "disabled"
            ? { mode: "disabled" }
            : { mode: "spawned", pid: 7777, child },
      );
      f.hasManagedProviderLocalServices.mockReturnValue(true);
      await withForeground(
        async ({ captureSignal, close, start, runtime, exited }) => {
          captureSignal("SIGUSR2")();
          await waitForCalls(completeUpdate);
          expectCallCount(1, close, lockRelease, f.stopManagedProviderLocalServices);
          expectUncalled(respawn, runtime.exit);
          const consumedIntents = f.consumeGatewayRestartIntentPayload.mock.calls.length;
          captureSignal("SIGUSR2")();
          await setImmediate();
          expect(f.consumeGatewayRestartIntentPayload).toHaveBeenCalledTimes(consumedIntents);
          updater.resolve({ respawn: true });
          if (readinessRejected || lateExit) {
            if (readinessRejected) {
              await waitForCalls(child.kill);
            } else {
              await withTimeout(flushEntered.promise, 5_000);
            }
            expectUncalled(runtime.exit);
            child.exitCode = 1;
            child.emit("exit", 1, null);
            releaseFlush.resolve();
            await setImmediate();
            expectUncalled(runtime.exit);
            child.emit("close", 1, null);
          }
          await expect(withTimeout(exited, lateExit ? 5_000 : 4_000)).resolves.toBe(1);
          expect(start).toHaveBeenCalledOnce();
          expectUncalled(cancelUpdate, commitUpdate, markFailure, f.writeGatewayRestartHandoff);
          if (readinessRejected) {
            expect(child.kill).toHaveBeenCalledOnce();
          } else if (lateExit) {
            expectUncalled(child.kill, f.killProcessTree);
          }
        },
        async ({ exited }) => {
          releaseFlush.resolve();
          child.exitCode = 1;
          child.emit("exit", 1, null);
          child.emit("close", 1, null);
          updater.resolve({ respawn: false });
          if (lateExit) {
            await withTimeout(exited, 5_000);
          }
        },
      );
    },
  );

  it("keeps a still-starting foreground successor alive", async ({ signal }) => {
    const port = await getFreePort();
    const source = `const net = require("node:net");
process.once("message", () => {
  net.createServer(socket => socket.end()).listen(Number(process.argv[1]), "127.0.0.1", () => {
    process.send("listening");
  });
});
process.send("parked");`;
    const child = spawn(process.execPath, ["--input-type=commonjs", "-e", source, String(port)], {
      detached: true,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    const closed = once(child, "close");
    void closed.catch(() => {});
    const message = async (expected: string, trigger = () => {}) => {
      const pending = once(child, "message");
      trigger();
      const [value] = await withinTest(
        awaitGateBeforeSettlement(
          pending,
          closed,
          "foreground successor closed before " + expected,
        ),
        signal,
      );
      expect(value).toBe(expected);
    };
    try {
      await message("parked");
      prepareForegroundHandoff();
      respawn.mockReturnValueOnce({ mode: "spawned", pid: child.pid, child });
      f.waitForGatewayHealthyRestart.mockResolvedValueOnce(
        f.respawnHealth({
          healthy: false,
          waitOutcome: "still-starting",
          runtime: { status: "running", pid: child.pid },
        }),
      );
      await f.withRunningGateway(
        async ({ captureSignal, start, exited }) => {
          captureSignal("SIGUSR2")();
          await expect(withTimeout(exited, 20_000)).resolves.toBe(0);
          expect(start).toHaveBeenCalledOnce();
          expectUncalled(
            cancelUpdate,
            commitUpdate,
            markFailure,
            f.writeGatewayRestartHandoff,
            f.killProcessTree,
          );
          await message("listening", () => {
            child.send("listen");
          });
          expect(child).toMatchObject({ exitCode: null, signalCode: null });
        },
        false,
        { lockPort: port },
      );
    } finally {
      await stopChildProcess(child, 5_000);
    }
  });

  it.each(["launchd", "external-update", "external"] as const)(
    "recovers an unavailable %s handoff",
    async (mode) => {
      const launchd = mode === "launchd";
      const update = mode !== "external";
      if (update) {
        f.peekGatewayRestartReason.mockReturnValue("update.run");
      }
      f.restartGatewayProcessWithFreshPid.mockReturnValueOnce({
        mode: "supervised",
        ...(launchd ? { handoffSpawned: Promise.resolve(false) } : {}),
      });
      if (!launchd) {
        f.writeGatewayRestartHandoff.mockResolvedValueOnce(null);
      }
      if (launchd) {
        f.setPlatform("darwin");
        process.env.OPENCLAW_LAUNCHD_LABEL = "ai.openclaw.gateway";
      } else {
        process.env.OPENCLAW_SUPERVISOR_MODE = "external";
      }
      await f.withRunningGateway(async ({ captureSignal, start, runtime, exited }) => {
        if (launchd) {
          vi.useFakeTimers();
        }
        captureSignal("SIGUSR2")();
        if (launchd) {
          await vi.advanceTimersByTimeAsync(1500);
        } else {
          await waitForCalls(start, 2);
        }
        expect(start).toHaveBeenCalledTimes(2);
        expect(runtime.exit).not.toHaveBeenCalled();
        if (update) {
          expect(markFailure).toHaveBeenCalledWith("restart-handoff-unavailable");
        } else {
          expectUncalled(markFailure);
        }
        if (!launchd) {
          expect(f.acquireGatewayLock).toHaveBeenCalledTimes(2);
        }
        captureSignal("SIGINT")();
        await expect(exited).resolves.toBe(0);
      });
    },
  );
}
