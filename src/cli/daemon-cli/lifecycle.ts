import { loadConfig, resolveGatewayPort } from "../../config/config.js";
import { resolveGatewayService } from "../../daemon/service.js";
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
import { resolveDaemonServiceEnv } from "./systemd-scope.js";
import type { DaemonLifecycleOptions } from "./types.js";

const POST_RESTART_HEALTH_ATTEMPTS = DEFAULT_RESTART_HEALTH_ATTEMPTS;
const POST_RESTART_HEALTH_DELAY_MS = DEFAULT_RESTART_HEALTH_DELAY_MS;

function failUnsupportedSystemScope(system: boolean | undefined): boolean {
  if (!system || process.platform === "linux") {
    return false;
  }
  defaultRuntime.error("--system is only supported on Linux.");
  defaultRuntime.exit(1);
  return true;
}

async function resolveGatewayRestartPort(env: NodeJS.ProcessEnv) {
  const service = resolveGatewayService();
  const command = await service.readCommand(env).catch(() => null);
  const serviceEnv = command?.environment ?? undefined;
  const mergedEnv = {
    ...(env as Record<string, string | undefined>),
    ...(serviceEnv ?? undefined),
  } as NodeJS.ProcessEnv;

  const portFromArgs = parsePortFromArgs(command?.programArguments);
  return portFromArgs ?? resolveGatewayPort(loadConfig(), mergedEnv);
}

export async function runDaemonUninstall(opts: DaemonLifecycleOptions = {}) {
  if (failUnsupportedSystemScope(opts.system)) {
    return;
  }
  const serviceEnv = resolveDaemonServiceEnv({ system: opts.system }) as NodeJS.ProcessEnv;
  return await runServiceUninstall({
    serviceNoun: "Gateway",
    service: resolveGatewayService(),
    opts,
    env: serviceEnv,
    stopBeforeUninstall: true,
    assertNotLoadedAfterUninstall: true,
  });
}

export async function runDaemonStart(opts: DaemonLifecycleOptions = {}) {
  if (failUnsupportedSystemScope(opts.system)) {
    return;
  }
  const serviceEnv = resolveDaemonServiceEnv({ system: opts.system }) as NodeJS.ProcessEnv;
  return await runServiceStart({
    serviceNoun: "Gateway",
    service: resolveGatewayService(),
    renderStartHints: () => renderGatewayServiceStartHints(serviceEnv),
    opts,
    env: serviceEnv,
  });
}

export async function runDaemonStop(opts: DaemonLifecycleOptions = {}) {
  if (failUnsupportedSystemScope(opts.system)) {
    return;
  }
  const serviceEnv = resolveDaemonServiceEnv({ system: opts.system }) as NodeJS.ProcessEnv;
  return await runServiceStop({
    serviceNoun: "Gateway",
    service: resolveGatewayService(),
    opts,
    env: serviceEnv,
  });
}

/**
 * Restart the gateway service service.
 * @returns `true` if restart succeeded, `false` if the service was not loaded.
 * Throws/exits on check or restart failures.
 */
export async function runDaemonRestart(opts: DaemonLifecycleOptions = {}): Promise<boolean> {
  if (failUnsupportedSystemScope(opts.system)) {
    return false;
  }
  const json = Boolean(opts.json);
  const serviceEnv = resolveDaemonServiceEnv({ system: opts.system }) as NodeJS.ProcessEnv;
  const service = resolveGatewayService();
  const restartPort = await resolveGatewayRestartPort(serviceEnv).catch(() =>
    resolveGatewayPort(loadConfig(), serviceEnv),
  );
  const restartWaitMs = POST_RESTART_HEALTH_ATTEMPTS * POST_RESTART_HEALTH_DELAY_MS;
  const restartWaitSeconds = Math.round(restartWaitMs / 1000);

  return await runServiceRestart({
    serviceNoun: "Gateway",
    service,
    renderStartHints: () => renderGatewayServiceStartHints(serviceEnv),
    opts,
    env: serviceEnv,
    checkTokenDrift: true,
    postRestartCheck: async ({ warnings, fail, stdout }) => {
      let health = await waitForGatewayHealthyRestart({
        service,
        port: restartPort,
        attempts: POST_RESTART_HEALTH_ATTEMPTS,
        delayMs: POST_RESTART_HEALTH_DELAY_MS,
        env: serviceEnv,
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
        await service.restart({ env: serviceEnv, stdout });
        health = await waitForGatewayHealthyRestart({
          service,
          port: restartPort,
          attempts: POST_RESTART_HEALTH_ATTEMPTS,
          delayMs: POST_RESTART_HEALTH_DELAY_MS,
          env: serviceEnv,
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
