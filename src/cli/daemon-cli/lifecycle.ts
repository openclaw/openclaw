import { loadConfig, resolveGatewayPort } from "../../config/config.js";
import { collectConfigServiceEnvVars } from "../../config/env-vars.js";
import { buildServiceEnvironment } from "../../daemon/service-env.js";
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
import type { DaemonLifecycleOptions } from "./types.js";

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

function normalizeServiceEnvironment(
  env: Record<string, string | undefined> | undefined,
): Record<string, string> {
  const normalized: Record<string, string> = {};
  if (!env) {
    return normalized;
  }
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      continue;
    }
    normalized[key] = trimmed;
  }
  return normalized;
}

function areServiceEnvironmentsEqual(
  left: Record<string, string | undefined> | undefined,
  right: Record<string, string | undefined> | undefined,
): boolean {
  const a = normalizeServiceEnvironment(left);
  const b = normalizeServiceEnvironment(right);
  const aKeys = Object.keys(a).toSorted();
  const bKeys = Object.keys(b).toSorted();
  if (aKeys.length !== bKeys.length) {
    return false;
  }
  for (let i = 0; i < aKeys.length; i += 1) {
    const key = aKeys[i];
    if (key !== bKeys[i]) {
      return false;
    }
    if (a[key] !== b[key]) {
      return false;
    }
  }
  return true;
}

async function maybeRefreshLaunchAgentEnvironment(params: {
  service: ReturnType<typeof resolveGatewayService>;
  port: number;
  json: boolean;
  warnings: string[];
}): Promise<void> {
  if (params.service.label !== "LaunchAgent") {
    return;
  }

  const command = await params.service.readCommand(process.env).catch(() => null);
  if (!command?.programArguments?.length) {
    return;
  }

  const cfg = loadConfig();
  const serviceEnvironment = buildServiceEnvironment({
    env: process.env as Record<string, string | undefined>,
    port: params.port,
    token: command.environment?.OPENCLAW_GATEWAY_TOKEN,
  });
  const refreshedEnvironment: Record<string, string | undefined> = {
    ...collectConfigServiceEnvVars(cfg),
    ...serviceEnvironment,
  };

  if (areServiceEnvironmentsEqual(command.environment, refreshedEnvironment)) {
    return;
  }

  const silentStdout = { write: () => true } as unknown as NodeJS.WritableStream;
  try {
    await params.service.install({
      env: process.env as Record<string, string | undefined>,
      stdout: silentStdout,
      programArguments: command.programArguments,
      workingDirectory: command.workingDirectory,
      environment: refreshedEnvironment,
    });
  } catch (err) {
    const warning = `Failed to refresh LaunchAgent environment before restart: ${String(err)}`;
    params.warnings.push(warning);
    if (!params.json) {
      defaultRuntime.log(theme.warn(warning));
    }
  }
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
  return await runServiceStop({
    serviceNoun: "Gateway",
    service: resolveGatewayService(),
    opts,
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
    preRestartCheck: async ({ warnings }) => {
      await maybeRefreshLaunchAgentEnvironment({
        service,
        port: restartPort,
        json,
        warnings,
      });
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
