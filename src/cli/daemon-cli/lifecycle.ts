import { loadConfig, resolveGatewayPort } from "../../config/config.js";
import { resolveGatewayService } from "../../daemon/service.js";
import { classifyPortListener, inspectPortUsage } from "../../infra/ports.js";
import { defaultRuntime } from "../../runtime.js";
import { theme } from "../../terminal/theme.js";
import { formatCliCommand } from "../command-format.js";
import {
  runServiceRestart,
  runServiceStart,
  runServiceStop,
  runServiceUninstall,
} from "./lifecycle-core.js";
import {
  DEFAULT_RESTART_HEALTH_ATTEMPTS,
  DEFAULT_RESTART_HEALTH_DELAY_MS,
  renderRestartDiagnostics,
  terminateStaleGatewayPids,
  waitForGatewayHealthyRestart,
} from "./restart-health.js";
import { parsePortFromArgs, renderGatewayServiceStartHints } from "./shared.js";
import type { DaemonLifecycleOptions } from "./types.js";

/**
 * Find gateway process PIDs listening on the given port.
 * Used as a signal-based fallback for stop/restart in containers that have
 * no systemd/launchd service manager.
 */
async function findGatewayPidsOnPort(port: number): Promise<number[]> {
  const portUsage = await inspectPortUsage(port).catch(() => null);
  if (!portUsage || portUsage.status !== "busy") {
    return [];
  }
  return portUsage.listeners
    .filter((l) => {
      const kind = classifyPortListener(l, port);
      // Target listeners that look like the gateway or unknown (container pid may not show full path).
      return kind === "gateway" || kind === "unknown";
    })
    .filter((l): l is typeof l & { pid: number } => Number.isFinite(l.pid) && (l.pid ?? 0) > 0)
    .map((l) => l.pid);
}

const POST_RESTART_HEALTH_ATTEMPTS = DEFAULT_RESTART_HEALTH_ATTEMPTS;
const POST_RESTART_HEALTH_DELAY_MS = DEFAULT_RESTART_HEALTH_DELAY_MS;

async function resolveGatewayRestartPort() {
  const service = resolveGatewayService();
  const command = await service.readCommand(process.env).catch(() => null);
  const serviceEnv = command?.environment ?? undefined;
  const mergedEnv = {
    ...(process.env as Record<string, string | undefined>),
    ...(serviceEnv ?? undefined),
  } as NodeJS.ProcessEnv;

  const portFromArgs = parsePortFromArgs(command?.programArguments);
  return portFromArgs ?? resolveGatewayPort(loadConfig(), mergedEnv);
}

export async function runDaemonUninstall(opts: DaemonLifecycleOptions = {}) {
  return await runServiceUninstall({
    serviceNoun: "Gateway",
    service: resolveGatewayService(),
    opts,
    stopBeforeUninstall: true,
    assertNotLoadedAfterUninstall: true,
  });
}

export async function runDaemonStart(opts: DaemonLifecycleOptions = {}) {
  return await runServiceStart({
    serviceNoun: "Gateway",
    service: resolveGatewayService(),
    renderStartHints: renderGatewayServiceStartHints,
    opts,
  });
}

export async function runDaemonStop(opts: DaemonLifecycleOptions = {}) {
  const json = Boolean(opts.json);
  const port = await resolveGatewayRestartPort().catch(() =>
    resolveGatewayPort(loadConfig(), process.env),
  );
  return await runServiceStop({
    serviceNoun: "Gateway",
    service: resolveGatewayService(),
    opts,
    // Signal-based fallback for containers without a service manager (#36137).
    onNotLoaded: async () => {
      const pids = await findGatewayPidsOnPort(port);
      if (pids.length === 0) {
        return false;
      }
      if (!json) {
        defaultRuntime.log(
          theme.muted(
            `No service manager detected. Sending SIGTERM to gateway process(es) on port ${port}: ${pids.join(", ")}`,
          ),
        );
      }
      for (const pid of pids) {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          // best-effort
        }
      }
      if (!json) {
        defaultRuntime.log(`Gateway stopped (SIGTERM sent to ${pids.length} process(es)).`);
      }
      return true;
    },
  });
}

/**
 * Restart the gateway service service.
 * @returns `true` if restart succeeded, `false` if the service was not loaded.
 * Throws/exits on check or restart failures.
 */
export async function runDaemonRestart(opts: DaemonLifecycleOptions = {}): Promise<boolean> {
  const json = Boolean(opts.json);
  const service = resolveGatewayService();
  const restartPort = await resolveGatewayRestartPort().catch(() =>
    resolveGatewayPort(loadConfig(), process.env),
  );
  const restartWaitMs = POST_RESTART_HEALTH_ATTEMPTS * POST_RESTART_HEALTH_DELAY_MS;
  const restartWaitSeconds = Math.round(restartWaitMs / 1000);

  return await runServiceRestart({
    serviceNoun: "Gateway",
    service,
    renderStartHints: renderGatewayServiceStartHints,
    opts,
    checkTokenDrift: true,
    // Signal-based fallback for containers without a service manager (#36137).
    onNotLoaded: async () => {
      const pids = await findGatewayPidsOnPort(restartPort);
      if (pids.length === 0) {
        return false;
      }
      if (!json) {
        defaultRuntime.log(
          theme.muted(
            `No service manager detected. Sending SIGUSR1 to gateway process(es) on port ${restartPort}: ${pids.join(", ")}`,
          ),
        );
      }
      for (const pid of pids) {
        try {
          process.kill(pid, "SIGUSR1");
        } catch {
          // best-effort
        }
      }
      if (!json) {
        defaultRuntime.log(`Gateway restart signal sent. Waiting for health...`);
      }
      return true;
    },
    postRestartCheck: async ({ warnings, fail, stdout }) => {
      let health = await waitForGatewayHealthyRestart({
        service,
        port: restartPort,
        attempts: POST_RESTART_HEALTH_ATTEMPTS,
        delayMs: POST_RESTART_HEALTH_DELAY_MS,
        includeUnknownListenersAsStale: process.platform === "win32",
      });

      if (!health.healthy && health.staleGatewayPids.length > 0) {
        const staleMsg = `Found stale gateway process(es): ${health.staleGatewayPids.join(", ")}.`;
        warnings.push(staleMsg);
        if (!json) {
          defaultRuntime.log(theme.warn(staleMsg));
          defaultRuntime.log(theme.muted("Stopping stale process(es) and retrying restart..."));
        }

        await terminateStaleGatewayPids(health.staleGatewayPids);
        await service.restart({ env: process.env, stdout });
        health = await waitForGatewayHealthyRestart({
          service,
          port: restartPort,
          attempts: POST_RESTART_HEALTH_ATTEMPTS,
          delayMs: POST_RESTART_HEALTH_DELAY_MS,
          includeUnknownListenersAsStale: process.platform === "win32",
        });
      }

      if (health.healthy) {
        return;
      }

      const diagnostics = renderRestartDiagnostics(health);
      const timeoutLine = `Timed out after ${restartWaitSeconds}s waiting for gateway port ${restartPort} to become healthy.`;
      const runningNoPortLine =
        health.runtime.status === "running" && health.portUsage.status === "free"
          ? `Gateway process is running but port ${restartPort} is still free (startup hang/crash loop or very slow VM startup).`
          : null;
      if (!json) {
        defaultRuntime.log(theme.warn(timeoutLine));
        if (runningNoPortLine) {
          defaultRuntime.log(theme.warn(runningNoPortLine));
        }
        for (const line of diagnostics) {
          defaultRuntime.log(theme.muted(line));
        }
      } else {
        warnings.push(timeoutLine);
        if (runningNoPortLine) {
          warnings.push(runningNoPortLine);
        }
        warnings.push(...diagnostics);
      }

      fail(`Gateway restart timed out after ${restartWaitSeconds}s waiting for health checks.`, [
        formatCliCommand("openclaw gateway status --deep"),
        formatCliCommand("openclaw doctor"),
      ]);
    },
  });
}
