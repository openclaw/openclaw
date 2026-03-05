import { spawnSync } from "node:child_process";
import fsSync from "node:fs";
import { isRestartEnabled } from "../../config/commands.js";
import {
  createConfigIO,
  loadConfig,
  readBestEffortConfig,
  recoverConfigFromBackups,
  resolveGatewayPort,
} from "../../config/config.js";
import { shouldRecoverInvalidConfigSnapshot } from "../../config/snapshot-recovery.js";
import { parseCmdScriptCommandLine } from "../../daemon/cmd-argv.js";
import { resolveGatewayService } from "../../daemon/service.js";
import { probeGateway } from "../../gateway/probe.js";
import { isGatewayArgv, parseProcCmdline } from "../../infra/gateway-process-argv.js";
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
  renderGatewayPortHealthDiagnostics,
  renderRestartDiagnostics,
  terminateStaleGatewayPids,
  waitForGatewayHealthyListener,
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

class GatewayServiceCommandReadError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "GatewayServiceCommandReadError";
  }
}

async function resolveGatewayServiceRuntimeEnv() {
  const service = resolveGatewayService();
  let command: Awaited<ReturnType<typeof service.readCommand>>;
  try {
    command = await service.readCommand(process.env);
  } catch (err) {
    throw new GatewayServiceCommandReadError(
      `failed to read gateway service command: ${String(err)}`,
      { cause: err },
    );
  }
  const serviceEnv = command?.environment ?? undefined;
  return {
    command,
    mergedEnv: {
      ...(process.env as Record<string, string | undefined>),
      ...(serviceEnv ?? undefined),
    } as NodeJS.ProcessEnv,
  };
}

async function resolveGatewayRestartPort() {
  const { command, mergedEnv } = await resolveGatewayServiceRuntimeEnv();
  const cfg = createConfigIO({ env: { ...mergedEnv } }).loadConfig();
  const portFromArgs = parsePortFromArgs(command?.programArguments);
  return portFromArgs ?? resolveGatewayPort(cfg, mergedEnv);
}

async function resolveGatewayRestartPortWithFallback(): Promise<number> {
  try {
    return await resolveGatewayRestartPort();
  } catch (err) {
    if (err instanceof GatewayServiceCommandReadError) {
      return resolveGatewayPort(loadConfig(), process.env);
    }
    throw err;
  }
}

async function runRestartConfigPreflight(params: {
  json: boolean;
  warnings: string[];
  fail: (message: string, hints?: string[]) => never;
}): Promise<void> {
  let mergedEnv = process.env;
  try {
    const serviceRuntime = await resolveGatewayServiceRuntimeEnv();
    mergedEnv = serviceRuntime.mergedEnv;
  } catch (err) {
    if (!(err instanceof GatewayServiceCommandReadError)) {
      throw err;
    }
  }
  const configIo = createConfigIO({ env: { ...mergedEnv } });
  const snapshot = await configIo.readConfigFileSnapshot().catch((err) => {
    params.fail(`Gateway restart blocked: failed to read config (${String(err)}).`, [
      formatCliCommand("openclaw config validate"),
      formatCliCommand("openclaw doctor"),
    ]);
    return null;
  });
  if (!snapshot || snapshot.valid) {
    return;
  }

  const issue = snapshot.issues[0];
  const issueText = issue ? `${issue.path || "<root>"}: ${issue.message}` : "unknown issue";
  if (!shouldRecoverInvalidConfigSnapshot(snapshot)) {
    params.fail(`Gateway restart blocked: config is invalid (${issueText}). Fix and retry.`, [
      formatCliCommand("openclaw config validate"),
      formatCliCommand("openclaw doctor"),
    ]);
  }

  const recovered = await recoverConfigFromBackups(
    { snapshot },
    {
      env: mergedEnv,
    },
  );
  if (recovered.recovered) {
    const message = `Last config update failed validation (${issueText}). Recovered from backup (${recovered.sourceBackupPath ?? "unknown"}). Retry your previous config command if you still need the change.`;
    params.warnings.push(message);
    if (!params.json) {
      defaultRuntime.log(theme.warn(message));
    }
    return;
  }

  const recoveryTail = recovered.error ? ` Recovery error: ${recovered.error}` : "";
  params.fail(
    `Gateway restart blocked: last config update failed validation (${issueText}).${recoveryTail} Retry the config command after fixing the issue.`,
    [formatCliCommand("openclaw config validate"), formatCliCommand("openclaw doctor")],
  );
}

function extractWindowsCommandLine(raw: string): string | null {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines) {
    if (!line.toLowerCase().startsWith("commandline=")) {
      continue;
    }
    const value = line.slice("commandline=".length).trim();
    return value || null;
  }
  return lines.find((line) => line.toLowerCase() !== "commandline") ?? null;
}

function readGatewayProcessArgsSync(pid: number): string[] | null {
  if (process.platform === "linux") {
    try {
      return parseProcCmdline(fsSync.readFileSync(`/proc/${pid}/cmdline`, "utf8"));
    } catch {
      return null;
    }
  }
  if (process.platform === "darwin") {
    const ps = spawnSync("ps", ["-o", "command=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 1000,
    });
    if (ps.error || ps.status !== 0) {
      return null;
    }
    const command = ps.stdout.trim();
    return command ? command.split(/\s+/) : null;
  }
  if (process.platform === "win32") {
    const wmic = spawnSync(
      "wmic",
      ["process", "where", `ProcessId=${pid}`, "get", "CommandLine", "/value"],
      {
        encoding: "utf8",
        timeout: 1000,
      },
    );
    if (wmic.error || wmic.status !== 0) {
      return null;
    }
    const command = extractWindowsCommandLine(wmic.stdout);
    return command ? parseCmdScriptCommandLine(command) : null;
  }
  return null;
}

function resolveGatewayListenerPids(port: number): number[] {
  return Array.from(new Set(findGatewayPidsOnPortSync(port)))
    .filter((pid): pid is number => Number.isFinite(pid) && pid > 0)
    .filter((pid) => {
      const args = readGatewayProcessArgsSync(pid);
      return args != null && isGatewayArgv(args, { allowGatewayBinary: true });
    });
}

function resolveGatewayPortFallback(): Promise<number> {
  return readBestEffortConfig()
    .then((cfg) => resolveGatewayPort(cfg, process.env))
    .catch(() => resolveGatewayPort(undefined, process.env));
}

function signalGatewayPid(pid: number, signal: "SIGTERM" | "SIGUSR1") {
  const args = readGatewayProcessArgsSync(pid);
  if (!args || !isGatewayArgv(args, { allowGatewayBinary: true })) {
    throw new Error(`refusing to signal non-gateway process pid ${pid}`);
  }
  process.kill(pid, signal);
}

function formatGatewayPidList(pids: number[]): string {
  return pids.join(", ");
}

async function assertUnmanagedGatewayRestartEnabled(port: number): Promise<void> {
  const probe = await probeGateway({
    url: `ws://127.0.0.1:${port}`,
    auth: {
      token: process.env.OPENCLAW_GATEWAY_TOKEN?.trim() || undefined,
      password: process.env.OPENCLAW_GATEWAY_PASSWORD?.trim() || undefined,
    },
    timeoutMs: 1_000,
  }).catch(() => null);

  if (!probe?.ok) {
    return;
  }
  if (!isRestartEnabled(probe.configSnapshot as { commands?: unknown } | undefined)) {
    throw new Error(
      "Gateway restart is disabled in the running gateway config (commands.restart=false); unmanaged SIGUSR1 restart would be ignored",
    );
  }
}

function resolveVerifiedGatewayListenerPids(port: number): number[] {
  return resolveGatewayListenerPids(port).filter(
    (pid): pid is number => Number.isFinite(pid) && pid > 0,
  );
}

async function stopGatewayWithoutServiceManager(port: number) {
  const pids = resolveVerifiedGatewayListenerPids(port);
  if (pids.length === 0) {
    return null;
  }
  for (const pid of pids) {
    signalGatewayPid(pid, "SIGTERM");
  }
  return {
    result: "stopped" as const,
    message: `Gateway stop signal sent to unmanaged process${pids.length === 1 ? "" : "es"} on port ${port}: ${formatGatewayPidList(pids)}.`,
  };
}

async function restartGatewayWithoutServiceManager(port: number) {
  await assertUnmanagedGatewayRestartEnabled(port);
  const pids = resolveVerifiedGatewayListenerPids(port);
  if (pids.length === 0) {
    return null;
  }
  if (pids.length > 1) {
    throw new Error(
      `multiple gateway processes are listening on port ${port}: ${formatGatewayPidList(pids)}; use "openclaw gateway status --deep" before retrying restart`,
    );
  }
  signalGatewayPid(pids[0], "SIGUSR1");
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
    resolveGatewayPortFallback(),
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
  let restartedWithoutServiceManager = false;
  let unmanagedRestartPort: number | null = null;
  const restartWaitMs = POST_RESTART_HEALTH_ATTEMPTS * POST_RESTART_HEALTH_DELAY_MS;
  const restartWaitSeconds = Math.round(restartWaitMs / 1000);

  return await runServiceRestart({
    serviceNoun: "Gateway",
    service,
    renderStartHints: renderGatewayServiceStartHints,
    opts,
    checkTokenDrift: true,
    preRestartCheck: async ({ json, warnings, fail }) => {
      await runRestartConfigPreflight({ json, warnings, fail });
    },
    onNotLoaded: async () => {
      const restartPort = await resolveGatewayRestartPortWithFallback().catch(() =>
        resolveGatewayPortFallback(),
      );
      const handled = await restartGatewayWithoutServiceManager(restartPort);
      if (handled) {
        restartedWithoutServiceManager = true;
        unmanagedRestartPort = restartPort;
      }
      return handled;
    },
    postRestartCheck: async ({ warnings, fail, stdout }) => {
      const restartPort = unmanagedRestartPort ?? (await resolveGatewayRestartPortWithFallback());
      if (restartedWithoutServiceManager) {
        const health = await waitForGatewayHealthyListener({
          port: restartPort,
          attempts: POST_RESTART_HEALTH_ATTEMPTS,
          delayMs: POST_RESTART_HEALTH_DELAY_MS,
        });
        if (health.healthy) {
          return;
        }

        const diagnostics = renderGatewayPortHealthDiagnostics(health);
        const timeoutLine = `Timed out after ${restartWaitSeconds}s waiting for gateway port ${restartPort} to become healthy.`;
        if (!json) {
          defaultRuntime.log(theme.warn(timeoutLine));
          for (const line of diagnostics) {
            defaultRuntime.log(theme.muted(line));
          }
        } else {
          warnings.push(timeoutLine);
          warnings.push(...diagnostics);
        }

        fail(`Gateway restart timed out after ${restartWaitSeconds}s waiting for health checks.`, [
          formatCliCommand("openclaw gateway status --deep"),
          formatCliCommand("openclaw doctor"),
        ]);
      }
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
