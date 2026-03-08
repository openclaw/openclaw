import type { startGatewayServer } from "../../gateway/server.js";
import { acquireGatewayLock, type GatewayLockTelemetryEvent } from "../../infra/gateway-lock.js";
import { restartGatewayProcessWithFreshPid } from "../../infra/process-respawn.js";
import {
  consumeGatewaySigusr1RestartAuthorization,
  isGatewaySigusr1RestartExternallyAllowed,
  markGatewaySigusr1RestartHandled,
} from "../../infra/restart.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  getActiveTaskCount,
  markGatewayDraining,
  resetAllLanes,
  waitForActiveTasks,
} from "../../process/command-queue.js";
import { createRestartIterationHook } from "../../process/restart-recovery.js";
import type { defaultRuntime } from "../../runtime.js";

const gatewayLog = createSubsystemLogger("gateway");

type GatewayRunSignalAction = "stop" | "restart";

export async function runGatewayLoop(params: {
  start: () => Promise<Awaited<ReturnType<typeof startGatewayServer>>>;
  runtime: typeof defaultRuntime;
  lockPort?: number;
}) {
  const formatOwner = (pid?: number) => (pid ? `pid=${pid}` : "pid=unknown");
  const onLockTelemetry = (event: GatewayLockTelemetryEvent) => {
    switch (event.event) {
      case "acquire-skipped": {
        const reason =
          event.reason === "multi-gateway-override"
            ? "OPENCLAW_ALLOW_MULTI_GATEWAY=1"
            : "test environment";
        gatewayLog.info(`singleton lock: skipped (${reason})`);
        return;
      }
      case "acquire-start": {
        const port = event.port != null ? `, port=${event.port}` : "";
        gatewayLog.info(
          `singleton lock: acquiring (${event.lockPath}, timeout=${event.timeoutMs}ms, stale=${event.staleMs}ms${port})`,
        );
        return;
      }
      case "acquire-contention":
        gatewayLog.warn(
          `singleton lock: waiting (status=${event.ownerStatus}, ${formatOwner(
            event.ownerPid,
          )}, waited=${event.waitedMs}ms)`,
        );
        return;
      case "stale-lock-recovered":
        gatewayLog.warn(
          `singleton lock: removed stale lock (${event.reason}, status=${event.ownerStatus}, ${formatOwner(
            event.ownerPid,
          )}, waited=${event.waitedMs}ms)`,
        );
        return;
      case "acquire-success":
        gatewayLog.info(
          `singleton lock: acquired (${event.lockPath}, waited=${event.waitedMs}ms, attempts=${event.attempts}, staleRecoveries=${event.staleRecoveries})`,
        );
        return;
      case "acquire-timeout":
        gatewayLog.error(
          `singleton lock: timeout after ${event.timeoutMs}ms (${formatOwner(
            event.ownerPid,
          )}, attempts=${event.attempts})`,
        );
        return;
    }
  };

  let lock = await acquireGatewayLock({ port: params.lockPort, onTelemetry: onLockTelemetry });
  let server: Awaited<ReturnType<typeof startGatewayServer>> | null = null;
  let shuttingDown = false;
  let restartResolver: (() => void) | null = null;

  const cleanupSignals = () => {
    process.removeListener("SIGTERM", onSigterm);
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGUSR1", onSigusr1);
  };
  const exitProcess = (code: number) => {
    cleanupSignals();
    params.runtime.exit(code);
  };
  const releaseLockIfHeld = async (): Promise<boolean> => {
    if (!lock) {
      return false;
    }
    await lock.release();
    lock = null;
    return true;
  };
  const reacquireLockForInProcessRestart = async (): Promise<boolean> => {
    try {
      lock = await acquireGatewayLock({ port: params.lockPort, onTelemetry: onLockTelemetry });
      return true;
    } catch (err) {
      gatewayLog.error(`failed to reacquire gateway lock for in-process restart: ${String(err)}`);
      exitProcess(1);
      return false;
    }
  };
  const handleRestartAfterServerClose = async () => {
    const hadLock = await releaseLockIfHeld();
    // Release the lock BEFORE spawning so the child can acquire it immediately.
    const respawn = restartGatewayProcessWithFreshPid();
    if (respawn.mode === "spawned" || respawn.mode === "supervised") {
      const modeLabel =
        respawn.mode === "spawned"
          ? `spawned pid ${respawn.pid ?? "unknown"}`
          : "supervisor restart";
      gatewayLog.info(`restart mode: full process restart (${modeLabel})`);
      exitProcess(0);
      return;
    }
    if (respawn.mode === "failed") {
      gatewayLog.warn(
        `full process restart failed (${respawn.detail ?? "unknown error"}); falling back to in-process restart`,
      );
    } else {
      gatewayLog.info(
        `restart mode: in-process restart (${respawn.detail ?? "OPENCLAW_NO_RESPAWN"})`,
      );
    }
    if (hadLock && !(await reacquireLockForInProcessRestart())) {
      return;
    }
    shuttingDown = false;
    restartResolver?.();
  };
  const handleStopAfterServerClose = async () => {
    await releaseLockIfHeld();
    exitProcess(0);
  };

  const DRAIN_TIMEOUT_MS = 30_000;
  const SHUTDOWN_TIMEOUT_MS = 5_000;

  const request = (action: GatewayRunSignalAction, signal: string) => {
    if (shuttingDown) {
      gatewayLog.info(`received ${signal} during shutdown; ignoring`);
      return;
    }
    shuttingDown = true;
    const isRestart = action === "restart";
    gatewayLog.info(`received ${signal}; ${isRestart ? "restarting" : "shutting down"}`);

    // Allow extra time for draining active turns on restart.
    const forceExitMs = isRestart ? DRAIN_TIMEOUT_MS + SHUTDOWN_TIMEOUT_MS : SHUTDOWN_TIMEOUT_MS;
    const forceExitTimer = setTimeout(() => {
      gatewayLog.error("shutdown timed out; exiting without full cleanup");
      exitProcess(0);
    }, forceExitMs);

    void (async () => {
      try {
        // On restart, wait for in-flight agent turns to finish before
        // tearing down the server so buffered messages are delivered.
        if (isRestart) {
          // Reject new enqueues immediately during the drain window so
          // sessions get an explicit restart error instead of silent task loss.
          markGatewayDraining();
          const activeTasks = getActiveTaskCount();
          if (activeTasks > 0) {
            gatewayLog.info(
              `draining ${activeTasks} active task(s) before restart (timeout ${DRAIN_TIMEOUT_MS}ms)`,
            );
            const { drained } = await waitForActiveTasks(DRAIN_TIMEOUT_MS);
            if (drained) {
              gatewayLog.info("all active tasks drained");
            } else {
              gatewayLog.warn("drain timeout reached; proceeding with restart");
            }
          }
        }

        await server?.close({
          reason: isRestart ? "gateway restarting" : "gateway stopping",
          restartExpectedMs: isRestart ? 1500 : null,
        });
      } catch (err) {
        gatewayLog.error(`shutdown error: ${String(err)}`);
      } finally {
        clearTimeout(forceExitTimer);
        server = null;
        if (isRestart) {
          await handleRestartAfterServerClose();
        } else {
          await handleStopAfterServerClose();
        }
      }
    })();
  };

  const onSigterm = () => {
    gatewayLog.info("signal SIGTERM received");
    request("stop", "SIGTERM");
  };
  const onSigint = () => {
    gatewayLog.info("signal SIGINT received");
    request("stop", "SIGINT");
  };
  const onSigusr1 = () => {
    gatewayLog.info("signal SIGUSR1 received");
    const authorized = consumeGatewaySigusr1RestartAuthorization();
    if (!authorized && !isGatewaySigusr1RestartExternallyAllowed()) {
      gatewayLog.warn(
        "SIGUSR1 restart ignored (not authorized; commands.restart=false or use gateway tool).",
      );
      return;
    }
    markGatewaySigusr1RestartHandled();
    request("restart", "SIGUSR1");
  };

  process.on("SIGTERM", onSigterm);
  process.on("SIGINT", onSigint);
  process.on("SIGUSR1", onSigusr1);

  try {
    const onIteration = createRestartIterationHook(() => {
      // After an in-process restart (SIGUSR1), reset command-queue lane state.
      // Interrupted tasks from the previous lifecycle may have left `active`
      // counts elevated (their finally blocks never ran), permanently blocking
      // new work from draining. This must happen here — at the restart
      // coordinator level — rather than inside individual subsystem init
      // functions, to avoid surprising cross-cutting side effects.
      resetAllLanes();
    });

    // Keep process alive; SIGUSR1 triggers an in-process restart (no supervisor required).
    // SIGTERM/SIGINT still exit after a graceful shutdown.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      onIteration();
      server = await params.start();
      await new Promise<void>((resolve) => {
        restartResolver = resolve;
      });
    }
  } finally {
    await releaseLockIfHeld();
    cleanupSignals();
  }
}
