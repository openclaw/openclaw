import path from "node:path";
import type { Command } from "commander";

import {
  DEFAULT_GATEWAY_DAEMON_RUNTIME,
  isGatewayDaemonRuntime,
} from "../commands/daemon-runtime.js";
import {
  createConfigIO,
  loadConfig,
  resolveConfigPath,
  resolveGatewayPort,
  resolveStateDir,
} from "../config/config.js";
import { resolveIsNixMode } from "../config/paths.js";
import {
  GATEWAY_LAUNCH_AGENT_LABEL,
  GATEWAY_SYSTEMD_SERVICE_NAME,
  GATEWAY_WINDOWS_TASK_NAME,
} from "../daemon/constants.js";
import {
  type FindExtraGatewayServicesOptions,
  findExtraGatewayServices,
  renderGatewayServiceCleanupHints,
} from "../daemon/inspect.js";
import { readLastGatewayErrorLine } from "../daemon/diagnostics.js";
import { resolveGatewayLogPaths } from "../daemon/launchd.js";
import { findLegacyGatewayServices } from "../daemon/legacy.js";
import { resolveGatewayProgramArguments } from "../daemon/program-args.js";
import { resolveGatewayService } from "../daemon/service.js";
import { callGateway } from "../gateway/call.js";
import { resolveGatewayBindHost } from "../gateway/net.js";
import {
  formatPortDiagnostics,
  inspectPortUsage,
  type PortListener,
  type PortUsageStatus,
} from "../infra/ports.js";
import { getResolvedLoggerSettings } from "../logging.js";
import { defaultRuntime } from "../runtime.js";
import { createDefaultDeps } from "./deps.js";
import { withProgress } from "./progress.js";

type ConfigSummary = {
  path: string;
  exists: boolean;
  valid: boolean;
  issues?: Array<{ path: string; message: string }>;
};

type GatewayStatusSummary = {
  bindMode: string;
  bindHost: string | null;
  port: number;
  portSource: "service args" | "env/config";
  probeUrl: string;
  probeNote?: string;
};

type DaemonStatus = {
  service: {
    label: string;
    loaded: boolean;
    loadedText: string;
    notLoadedText: string;
    command?: {
      programArguments: string[];
      workingDirectory?: string;
      environment?: Record<string, string>;
      sourcePath?: string;
    } | null;
    runtime?: {
      status?: string;
      state?: string;
      subState?: string;
      pid?: number;
      lastExitStatus?: number;
      lastExitReason?: string;
      lastRunResult?: string;
      lastRunTime?: string;
      detail?: string;
      cachedLabel?: boolean;
      missingUnit?: boolean;
    };
  };
  config?: {
    cli: ConfigSummary;
    daemon?: ConfigSummary;
    mismatch?: boolean;
  };
  gateway?: GatewayStatusSummary;
  port?: {
    port: number;
    status: PortUsageStatus;
    listeners: PortListener[];
    hints: string[];
  };
  portCli?: {
    port: number;
    status: PortUsageStatus;
    listeners: PortListener[];
    hints: string[];
  };
  lastError?: string;
  rpc?: {
    ok: boolean;
    error?: string;
    url?: string;
  };
  legacyServices: Array<{ label: string; detail: string }>;
  extraServices: Array<{ label: string; detail: string; scope: string }>;
};

export type GatewayRpcOpts = {
  url?: string;
  token?: string;
  password?: string;
  timeout?: string;
  json?: boolean;
};

export type DaemonStatusOptions = {
  rpc: GatewayRpcOpts;
  probe: boolean;
  json: boolean;
} & FindExtraGatewayServicesOptions;

export type DaemonInstallOptions = {
  port?: string | number;
  runtime?: string;
  token?: string;
};

function parsePort(raw: unknown): number | null {
  if (raw === undefined || raw === null) return null;
  const value =
    typeof raw === "string"
      ? raw
      : typeof raw === "number" || typeof raw === "bigint"
        ? raw.toString()
        : null;
  if (value === null) return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

async function probeGatewayStatus(opts: GatewayRpcOpts) {
  try {
    await withProgress(
      {
        label: "Checking gateway status...",
        indeterminate: true,
        enabled: opts.json !== true,
      },
      async () =>
        await callGateway({
          url: opts.url,
          token: opts.token,
          password: opts.password,
          method: "status",
          timeoutMs: Number(opts.timeout ?? 10_000),
          clientName: "cli",
          mode: "cli",
        }),
    );
    return { ok: true } as const;
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    } as const;
  }
}

function formatRuntimeStatus(runtime: DaemonStatus["service"]["runtime"]) {
  if (!runtime) return null;
  const status = runtime.status ?? "unknown";
  const details: string[] = [];
  if (runtime.pid) details.push(`pid ${runtime.pid}`);
  if (runtime.state && runtime.state.toLowerCase() !== status) {
    details.push(`state ${runtime.state}`);
  }
  if (runtime.subState) details.push(`sub ${runtime.subState}`);
  if (runtime.lastExitStatus !== undefined) {
    details.push(`last exit ${runtime.lastExitStatus}`);
  }
  if (runtime.lastExitReason) {
    details.push(`reason ${runtime.lastExitReason}`);
  }
  if (runtime.lastRunResult) {
    details.push(`last run ${runtime.lastRunResult}`);
  }
  if (runtime.lastRunTime) {
    details.push(`last run time ${runtime.lastRunTime}`);
  }
  if (runtime.detail) details.push(runtime.detail);
  return details.length > 0 ? `${status} (${details.join(", ")})` : status;
}

function shouldReportPortUsage(
  status: PortUsageStatus | undefined,
  rpcOk?: boolean,
) {
  if (status !== "busy") return false;
  if (rpcOk === true) return false;
  return true;
}

function renderRuntimeHints(
  runtime: DaemonStatus["service"]["runtime"],
): string[] {
  if (!runtime) return [];
  const hints: string[] = [];
  const fileLog = (() => {
    try {
      return getResolvedLoggerSettings().file;
    } catch {
      return null;
    }
  })();
  if (runtime.missingUnit) {
    hints.push("Service not installed. Run: clawdbot daemon install");
    if (fileLog) hints.push(`File logs: ${fileLog}`);
    return hints;
  }
  if (runtime.status === "stopped") {
    if (fileLog) hints.push(`File logs: ${fileLog}`);
    if (process.platform === "darwin") {
      const logs = resolveGatewayLogPaths(process.env);
      hints.push(`Launchd stdout (if installed): ${logs.stdoutPath}`);
      hints.push(`Launchd stderr (if installed): ${logs.stderrPath}`);
    } else if (process.platform === "linux") {
      hints.push(
        "Logs: journalctl --user -u clawdbot-gateway.service -n 200 --no-pager",
      );
    } else if (process.platform === "win32") {
      hints.push('Logs: schtasks /Query /TN "Clawdbot Gateway" /V /FO LIST');
    }
  }
  return hints;
}

function renderGatewayServiceStartHints(): string[] {
  const base = ["clawdbot daemon install", "clawdbot gateway"];
  switch (process.platform) {
    case "darwin":
      return [
        ...base,
        `launchctl bootstrap gui/$UID ~/Library/LaunchAgents/${GATEWAY_LAUNCH_AGENT_LABEL}.plist`,
      ];
    case "linux":
      return [
        ...base,
        `systemctl --user start ${GATEWAY_SYSTEMD_SERVICE_NAME}.service`,
      ];
    case "win32":
      return [...base, `schtasks /Run /TN "${GATEWAY_WINDOWS_TASK_NAME}"`];
    default:
      return base;
  }
}

async function gatherDaemonStatus(opts: {
  rpc: GatewayRpcOpts;
  probe: boolean;
  deep?: boolean;
}): Promise<DaemonStatus> {
  const service = resolveGatewayService();
  const [loaded, command, runtime] = await Promise.all([
    service.isLoaded({ env: process.env }).catch(() => false),
    service.readCommand(process.env).catch(() => null),
    service.readRuntime(process.env).catch(() => undefined),
  ]);
  let portStatus: DaemonStatus["port"] | undefined;
  try {
    const cfg = loadConfig();
    if (cfg.gateway?.mode !== "remote") {
      const port = resolveGatewayPort(cfg, process.env);
      const diagnostics = await inspectPortUsage(port);
      portStatus = {
        port: diagnostics.port,
        status: diagnostics.status,
        listeners: diagnostics.listeners,
        hints: diagnostics.hints,
      };
    }
  } catch {
    portStatus = undefined;
  }
  const legacyServices = await findLegacyGatewayServices(process.env);
  const extraServices = await findExtraGatewayServices(process.env, {
    deep: opts.deep,
  });
  const rpc = opts.probe ? await probeGatewayStatus(opts.rpc) : undefined;
  let lastError: string | undefined;
  if (
    loaded &&
    runtime?.status === "running" &&
    portStatus &&
    portStatus.status !== "busy"
  ) {
    lastError = (await readLastGatewayErrorLine(process.env)) ?? undefined;
  }

  return {
    service: {
      label: service.label,
      loaded,
      loadedText: service.loadedText,
      notLoadedText: service.notLoadedText,
      command,
      runtime,
    },
    port: portStatus,
    lastError,
    rpc,
    legacyServices,
    extraServices,
  };
}

function printDaemonStatus(status: DaemonStatus, opts: { json: boolean }) {
  if (opts.json) {
    defaultRuntime.log(JSON.stringify(status, null, 2));
    return;
  }

  const { service, rpc, legacyServices, extraServices } = status;
  defaultRuntime.log(
    `Service: ${service.label} (${service.loaded ? service.loadedText : service.notLoadedText})`,
  );
  try {
    const logFile = getResolvedLoggerSettings().file;
    defaultRuntime.log(`File logs: ${logFile}`);
  } catch {
    // ignore missing config/log resolution
  }
  if (service.command?.programArguments?.length) {
    defaultRuntime.log(
      `Command: ${service.command.programArguments.join(" ")}`,
    );
  }
  if (service.command?.workingDirectory) {
    defaultRuntime.log(`Working dir: ${service.command.workingDirectory}`);
  }
  const runtimeLine = formatRuntimeStatus(service.runtime);
  if (runtimeLine) {
    defaultRuntime.log(`Runtime: ${runtimeLine}`);
  }
  if (rpc) {
    if (rpc.ok) {
      defaultRuntime.log("RPC probe: ok");
    } else {
      defaultRuntime.error(`RPC probe: failed (${rpc.error})`);
    }
  }
  if (service.runtime?.missingUnit) {
    defaultRuntime.error("Service unit not found.");
    for (const hint of renderRuntimeHints(service.runtime)) {
      defaultRuntime.error(hint);
    }
  } else if (service.loaded && service.runtime?.status === "stopped") {
    defaultRuntime.error(
      "Service is loaded but not running (likely exited immediately).",
    );
    for (const hint of renderRuntimeHints(service.runtime)) {
      defaultRuntime.error(hint);
    }
  }
  if (service.runtime?.cachedLabel) {
    defaultRuntime.error(
      `LaunchAgent label cached but plist missing. Clear with: launchctl bootout gui/$UID/${GATEWAY_LAUNCH_AGENT_LABEL}`,
    );
    defaultRuntime.error("Then reinstall: clawdbot daemon install");
  }
  if (status.port && shouldReportPortUsage(status.port.status, rpc?.ok)) {
    for (const line of formatPortDiagnostics({
      port: status.port.port,
      status: status.port.status,
      listeners: status.port.listeners,
      hints: status.port.hints,
    })) {
      defaultRuntime.error(line);
    }
  }
  if (
    service.loaded &&
    service.runtime?.status === "running" &&
    status.port &&
    status.port.status !== "busy"
  ) {
    defaultRuntime.error(
      `Gateway port ${status.port.port} is not listening (service appears running).`,
    );
    if (status.lastError) {
      defaultRuntime.error(`Last gateway error: ${status.lastError}`);
    }
    if (process.platform === "linux") {
      defaultRuntime.error(
        `Logs: journalctl --user -u ${GATEWAY_SYSTEMD_SERVICE_NAME}.service -n 200 --no-pager`,
      );
    } else if (process.platform === "darwin") {
      const logs = resolveGatewayLogPaths(process.env);
      defaultRuntime.error(`Logs: ${logs.stdoutPath}`);
      defaultRuntime.error(`Errors: ${logs.stderrPath}`);
    }
  }

  if (legacyServices.length > 0) {
    defaultRuntime.error("Legacy Clawdis services detected:");
    for (const svc of legacyServices) {
      defaultRuntime.error(`- ${svc.label} (${svc.detail})`);
    }
    defaultRuntime.error("Cleanup: clawdbot doctor");
  }

  if (extraServices.length > 0) {
    defaultRuntime.error("Other gateway-like services detected (best effort):");
    for (const svc of extraServices) {
      defaultRuntime.error(`- ${svc.label} (${svc.scope}, ${svc.detail})`);
    }
    for (const hint of renderGatewayServiceCleanupHints()) {
      defaultRuntime.error(`Cleanup hint: ${hint}`);
    }
  }

  if (legacyServices.length > 0 || extraServices.length > 0) {
    defaultRuntime.error(
      "Recommendation: run a single gateway per machine. One gateway supports multiple agents.",
    );
    defaultRuntime.error(
      "If you need multiple gateways, isolate ports + config/state (see docs: /gateway#multiple-gateways-same-host).",
    );
  }
}

export async function runDaemonStatus(opts: DaemonStatusOptions) {
  try {
    const status = await gatherDaemonStatus({
      rpc: opts.rpc,
      probe: Boolean(opts.probe),
      deep: Boolean(opts.deep),
    });
    printDaemonStatus(status, { json: Boolean(opts.json) });
  } catch (err) {
    defaultRuntime.error(`Daemon status failed: ${String(err)}`);
    defaultRuntime.exit(1);
  }
}

export async function runDaemonInstall(opts: DaemonInstallOptions) {
  if (resolveIsNixMode(process.env)) {
    defaultRuntime.error("Nix mode detected; daemon install is disabled.");
    defaultRuntime.exit(1);
    return;
  }

  const cfg = loadConfig();
  const portOverride = parsePort(opts.port);
  if (opts.port !== undefined && portOverride === null) {
    defaultRuntime.error("Invalid port");
    defaultRuntime.exit(1);
    return;
  }
  const port = portOverride ?? resolveGatewayPort(cfg);
  if (!Number.isFinite(port) || port <= 0) {
    defaultRuntime.error("Invalid port");
    defaultRuntime.exit(1);
    return;
  }
  const runtimeRaw = opts.runtime
    ? String(opts.runtime)
    : DEFAULT_GATEWAY_DAEMON_RUNTIME;
  if (!isGatewayDaemonRuntime(runtimeRaw)) {
    defaultRuntime.error('Invalid --runtime (use "node" or "bun")');
    defaultRuntime.exit(1);
    return;
  }

  const service = resolveGatewayService();
  let loaded = false;
  try {
    loaded = await service.isLoaded({ env: process.env });
  } catch (err) {
    defaultRuntime.error(`Gateway service check failed: ${String(err)}`);
    defaultRuntime.exit(1);
    return;
  }
  if (loaded) {
    defaultRuntime.log(`Gateway service already ${service.loadedText}.`);
    return;
  }

  const devMode =
    process.argv[1]?.includes(`${path.sep}src${path.sep}`) &&
    process.argv[1]?.endsWith(".ts");
  const { programArguments, workingDirectory } =
    await resolveGatewayProgramArguments({
      port,
      dev: devMode,
      runtime: runtimeRaw,
    });
  const environment: Record<string, string | undefined> = {
    PATH: process.env.PATH,
    CLAWDBOT_GATEWAY_TOKEN:
      opts.token ||
      cfg.gateway?.auth?.token ||
      process.env.CLAWDBOT_GATEWAY_TOKEN,
    CLAWDBOT_LAUNCHD_LABEL:
      process.platform === "darwin" ? GATEWAY_LAUNCH_AGENT_LABEL : undefined,
  };

  try {
    await service.install({
      env: process.env,
      stdout: process.stdout,
      programArguments,
      workingDirectory,
      environment,
    });
  } catch (err) {
    defaultRuntime.error(`Gateway install failed: ${String(err)}`);
    defaultRuntime.exit(1);
  }
}

export async function runDaemonUninstall() {
  if (resolveIsNixMode(process.env)) {
    defaultRuntime.error("Nix mode detected; daemon uninstall is disabled.");
    defaultRuntime.exit(1);
    return;
  }

  const service = resolveGatewayService();
  try {
    await service.uninstall({ env: process.env, stdout: process.stdout });
  } catch (err) {
    defaultRuntime.error(`Gateway uninstall failed: ${String(err)}`);
    defaultRuntime.exit(1);
  }
}

export async function runDaemonStart() {
  const service = resolveGatewayService();
  let loaded = false;
  try {
    loaded = await service.isLoaded({ env: process.env });
  } catch (err) {
    defaultRuntime.error(`Gateway service check failed: ${String(err)}`);
    defaultRuntime.exit(1);
    return;
  }
  if (!loaded) {
    defaultRuntime.log(`Gateway service ${service.notLoadedText}.`);
    for (const hint of renderGatewayServiceStartHints()) {
      defaultRuntime.log(`Start with: ${hint}`);
    }
    return;
  }
  try {
    await service.restart({ stdout: process.stdout });
  } catch (err) {
    defaultRuntime.error(`Gateway start failed: ${String(err)}`);
    for (const hint of renderGatewayServiceStartHints()) {
      defaultRuntime.error(`Start with: ${hint}`);
    }
    defaultRuntime.exit(1);
  }
}

export async function runDaemonStop() {
  const service = resolveGatewayService();
  let loaded = false;
  try {
    loaded = await service.isLoaded({ env: process.env });
  } catch (err) {
    defaultRuntime.error(`Gateway service check failed: ${String(err)}`);
    defaultRuntime.exit(1);
    return;
  }
  if (!loaded) {
    defaultRuntime.log(`Gateway service ${service.notLoadedText}.`);
    return;
  }
  try {
    await service.stop({ stdout: process.stdout });
  } catch (err) {
    defaultRuntime.error(`Gateway stop failed: ${String(err)}`);
    defaultRuntime.exit(1);
  }
}

export async function runDaemonRestart() {
  const service = resolveGatewayService();
  let loaded = false;
  try {
    loaded = await service.isLoaded({ env: process.env });
  } catch (err) {
    defaultRuntime.error(`Gateway service check failed: ${String(err)}`);
    defaultRuntime.exit(1);
    return;
  }
  if (!loaded) {
    defaultRuntime.log(`Gateway service ${service.notLoadedText}.`);
    for (const hint of renderGatewayServiceStartHints()) {
      defaultRuntime.log(`Start with: ${hint}`);
    }
    return;
  }
  try {
    await service.restart({ stdout: process.stdout });
  } catch (err) {
    defaultRuntime.error(`Gateway restart failed: ${String(err)}`);
    defaultRuntime.exit(1);
  }
}

export function registerDaemonCli(program: Command) {
  const daemon = program
    .command("daemon")
    .description(
      "Manage the Gateway daemon service (launchd/systemd/schtasks)",
    );

  daemon
    .command("status")
    .description("Show daemon install status + probe the Gateway")
    .option(
      "--url <url>",
      "Gateway WebSocket URL (defaults to config/remote/local)",
    )
    .option("--token <token>", "Gateway token (if required)")
    .option("--password <password>", "Gateway password (password auth)")
    .option("--timeout <ms>", "Timeout in ms", "10000")
    .option("--no-probe", "Skip RPC probe")
    .option("--deep", "Scan system-level services", false)
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runDaemonStatus({
        rpc: opts,
        probe: Boolean(opts.probe),
        deep: Boolean(opts.deep),
        json: Boolean(opts.json),
      });
    });

  daemon
    .command("install")
    .description("Install the Gateway service (launchd/systemd/schtasks)")
    .option("--port <port>", "Gateway port")
    .option("--runtime <runtime>", "Daemon runtime (node|bun). Default: node")
    .option("--token <token>", "Gateway token (token auth)")
    .action(async (opts) => {
      await runDaemonInstall(opts);
    });

  daemon
    .command("uninstall")
    .description("Uninstall the Gateway service (launchd/systemd/schtasks)")
    .action(async () => {
      await runDaemonUninstall();
    });

  daemon
    .command("start")
    .description("Start the Gateway service (launchd/systemd/schtasks)")
    .action(async () => {
      await runDaemonStart();
    });

  daemon
    .command("stop")
    .description("Stop the Gateway service (launchd/systemd/schtasks)")
    .action(async () => {
      await runDaemonStop();
    });

  daemon
    .command("restart")
    .description("Restart the Gateway service (launchd/systemd/schtasks)")
    .action(async () => {
      await runDaemonRestart();
    });

  // Build default deps (parity with other commands).
  void createDefaultDeps();
}
