import { readBestEffortConfig, resolveGatewayPort } from "../../config/config.js";
import { resolveGatewayService } from "../../daemon/service.js";
import { findGatewayPidsOnPortSync } from "../../infra/restart.js";
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

const POST_RESTART_HEALTH_ATTEMPTS = DEFAULT_RESTART_HEALTH_ATTEMPTS;
const POST_RESTART_HEALTH_DELAY_MS = DEFAULT_RESTART_HEALTH_DELAY_MS;

async function resolveGatewayLifecyclePort(service = resolveGatewayService()) {
  const command = await service.readCommand(process.env).catch(() => null);
  const serviceEnv = command?.environment ?? undefined;
  const mergedEnv = {
    ...(process.env as Record<string, string | undefined>),
    ...(serviceEnv ?? undefined),
  } as NodeJS.ProcessEnv;

  const portFromArgs = parsePortFromArgs(command?.programArguments);
  return portFromArgs ?? resolveGatewayPort(await readBestEffortConfig(), mergedEnv);
}

function resolveGatewayListenerPids(port: number): number[] {
  return Array.from(new Set(findGatewayPidsOnPortSync(port))).filter(
    (pid): pid is number => Number.isFinite(pid) && pid > 0,
  );
}

async function stopGatewayWithoutServiceManager(port: number) {
  const pids = resolveGatewayListenerPids(port);
  if (pids.length === 0) {
    return null;
  }
  for (const pid of pids) {
    process.kill(pid, "SIGTERM");
  }
  return {
    result: "stopped" as const,
    message: `Gateway stop signal sent to unmanaged process${pids.length === 1 ? "" : "es"} on port ${port}: ${pids.join(", ")}.`,
  };
}

async function restartGatewayWithoutServiceManager(port: number) {
  const pids = resolveGatewayListenerPids(port);
  if (pids.length === 0) {
    return null;
  }
  if (pids.length > 1) {
    throw new Error(
      `multiple gateway processes are listening on port ${port}: ${pids.join(", ")}; use "openclaw gateway status --deep" before retrying restart`,
    );
  }
  process.kill(pids[0], "SIGUSR1");
  return {
    result: "restarted" as const,
    message: `Gateway restart signal sent to unmanaged process on port ${port}: ${pids[0]}.`,
  };
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
  const service = resolveGatewayService();
  const gatewayPort = await resolveGatewayLifecyclePort(service).catch(() =>
    resolveGatewayPort(loadConfig(), process.env),
  );
  return await runServiceStop({
    serviceNoun: "Gateway",
    service,
    opts,
    onNotLoaded: async () => stopGatewayWithoutServiceManager(gatewayPort),
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
  const restartPort = await resolveGatewayLifecyclePort(service).catch(() =>
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
    onNotLoaded: async () => restartGatewayWithoutServiceManager(restartPort),
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
