import type { startGatewayServer } from "../../gateway/server.js";
import { acquireGatewayLock } from "../../infra/gateway-lock.js";
import {
  consumeGatewaySigusr1RestartAuthorization,
  isGatewaySigusr1RestartExternallyAllowed,
} from "../../infra/restart.js";
import { isTransientNetworkError } from "../../infra/unhandled-rejections.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { defaultRuntime } from "../../runtime.js";
import { calculateBackoffMs, applyJitter } from "./backoff.js";
import { recordCrash, classifyError } from "./crash-tracker.js";
import { killAllChildrenSync } from "../../infra/child-registry.js";

const gatewayLog = createSubsystemLogger("gateway");

type GatewayRunSignalAction = "stop" | "restart";

export async function runGatewayLoop(params: {
  start: () => Promise<Awaited<ReturnType<typeof startGatewayServer>>>;
  runtime: typeof defaultRuntime;
}) {
  const lock = await acquireGatewayLock();
  let server: Awaited<ReturnType<typeof startGatewayServer>> | null = null;
  let shuttingDown = false;
  let restartResolver: ((reason: { isUserInitiated: boolean }) => void) | null = null;

  const cleanupSignals = () => {
    process.removeListener("SIGTERM", onSigterm);
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGUSR1", onSigusr1);
  };

  const request = (action: GatewayRunSignalAction, signal: string) => {
    if (shuttingDown) {
      gatewayLog.info(`received ${signal} during shutdown; ignoring`);
      return;
    }
    shuttingDown = true;
    const isRestart = action === "restart";
    gatewayLog.info(`received ${signal}; ${isRestart ? "restarting" : "shutting down"}`);

    const forceExitTimer = setTimeout(() => {
      gatewayLog.error("shutdown timed out; exiting without full cleanup");
      cleanupSignals();
      params.runtime.exit(0);
    }, 5000);

    void (async () => {
      try {
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
          shuttingDown = false;
          restartResolver?.({ isUserInitiated: action === "restart" });
        } else {
          cleanupSignals();
          params.runtime.exit(0);
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
        "SIGUSR1 restart ignored (not authorized; enable commands.restart or use gateway tool).",
      );
      return;
    }
    request("restart", "SIGUSR1");
  };

  process.on("SIGTERM", onSigterm);
  process.on("SIGINT", onSigint);
  process.on("SIGUSR1", onSigusr1);

  // Register exit handler for crash scenarios (sync only - can't await in 'exit' handler)
  process.on("exit", () => {
    killAllChildrenSync();
  });

  let consecutiveFailures = 0;
  const STABILITY_THRESHOLD_MS = 60_000;

  try {
    // Keep process alive; SIGUSR1 triggers an in-process restart (no supervisor required).
    // SIGTERM/SIGINT still exit after a graceful shutdown.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      // Calculate and apply backoff with jitter
      const baseBackoffMs = calculateBackoffMs(consecutiveFailures);
      const backoffMs = applyJitter(baseBackoffMs);

      if (backoffMs > 0) {
        gatewayLog.warn(
          `Restarting gateway in ${backoffMs}ms after failure (attempt ${consecutiveFailures + 1})`,
        );
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }

      const startAttemptMs = Date.now();

      try {
        server = await params.start();
      } catch (err) {
        // Only retry transient network errors; rethrow fatal/config errors
        if (!isTransientNetworkError(err)) {
          throw err;
        }
        gatewayLog.error(`Gateway startup failed (transient): ${String(err)}`);
        recordCrash({
          errorType: classifyError(err),
          errorMessage: err instanceof Error ? err.message : String(err),
          uptimeMs: 0,
          backoffMs,
          consecutiveFailures: consecutiveFailures + 1,
        });
        consecutiveFailures++;
        continue;
      }

      // Server started successfully - wait for restart signal
      const restartReason = await new Promise<{ isUserInitiated: boolean }>((resolve) => {
        restartResolver = resolve;
      });

      const uptimeMs = Date.now() - startAttemptMs;

      // Determine backoff reset behavior based on uptime and restart type
      if (restartReason.isUserInitiated) {
        // User-initiated restart (SIGUSR1): no backoff
        consecutiveFailures = 0;
      } else if (uptimeMs >= STABILITY_THRESHOLD_MS) {
        // Crashed after stable uptime: reset to minimal backoff
        recordCrash({
          errorType: "runtime_error",
          errorMessage: "crashed after stable uptime",
          uptimeMs,
          backoffMs: calculateBackoffMs(1),
          consecutiveFailures: 1,
        });
        consecutiveFailures = 1;
      } else {
        // Crashed during startup or early runtime: increment backoff
        recordCrash({
          errorType: "runtime_error",
          errorMessage: "crashed during early runtime",
          uptimeMs,
          backoffMs: calculateBackoffMs(consecutiveFailures + 1),
          consecutiveFailures: consecutiveFailures + 1,
        });
        consecutiveFailures++;
      }
    }
  } finally {
    await lock?.release();
    cleanupSignals();
  }
}
