import { buildNodeInstallPlan } from "../../commands/node-daemon-install-helpers.js";
import {
  DEFAULT_NODE_DAEMON_RUNTIME,
  isNodeDaemonRuntime,
} from "../../commands/node-daemon-runtime.js";
import { resolveIsNixMode } from "../../config/paths.js";
import {
  resolveNodeLaunchAgentLabel,
  resolveNodeSystemdServiceName,
  resolveNodeWindowsTaskName,
} from "../../daemon/constants.js";
import { resolveNodeService } from "../../daemon/node-service.js";
import {
  buildPlatformRuntimeLogHints,
  buildPlatformServiceStartHints,
} from "../../daemon/runtime-hints.js";
import type { GatewayServiceRuntime } from "../../daemon/service-runtime.js";
import type { GatewayServiceCommandConfig } from "../../daemon/service-types.js";
import { loadNodeHostConfig } from "../../node-host/config.js";
import { defaultRuntime } from "../../runtime.js";
import { colorize } from "../../terminal/theme.js";
import { formatCliCommand } from "../command-format.js";
import {
  runServiceRestart,
  runServiceStart,
  runServiceStop,
  runServiceUninstall,
} from "../daemon-cli/lifecycle-core.js";
import {
  buildDaemonServiceSnapshot,
  createDaemonActionContext,
  installDaemonServiceAndEmit,
} from "../daemon-cli/response.js";
import {
  createCliStatusTextStyles,
  formatRuntimeStatus,
  parsePort,
  redactSensitiveDaemonEnv,
  resolveRuntimeStatusColor,
} from "../daemon-cli/shared.js";
import { parseHeaderArgs } from "./header-args.js";

type NodeDaemonInstallOptions = {
  host?: string;
  port?: string | number;
  tls?: boolean;
  tlsFingerprint?: string;
  header?: string[];
  nodeId?: string;
  displayName?: string;
  runtime?: string;
  force?: boolean;
  json?: boolean;
};

type NodeDaemonLifecycleOptions = {
  json?: boolean;
};

type NodeDaemonStatusOptions = {
  json?: boolean;
};

function hasNodeHeaderEnv(env: NodeJS.ProcessEnv): boolean {
  return Boolean(
    env.OPENCLAW_NODE_HEADERS?.trim() ||
    env.CF_ACCESS_CLIENT_ID?.trim() ||
    env.CF_ACCESS_CLIENT_SECRET?.trim(),
  );
}

function redactNodeServiceCommandEnv(
  command: GatewayServiceCommandConfig | null,
): GatewayServiceCommandConfig | null {
  if (!command?.environment) {
    return command;
  }
  const redacted = redactSensitiveDaemonEnv(command.environment);
  return { ...command, environment: redacted };
}

function renderNodeServiceStartHints(): string[] {
  return buildPlatformServiceStartHints({
    installCommand: formatCliCommand("openclaw node install"),
    startCommand: formatCliCommand("openclaw node start"),
    launchAgentPlistPath: `~/Library/LaunchAgents/${resolveNodeLaunchAgentLabel()}.plist`,
    systemdServiceName: resolveNodeSystemdServiceName(),
    windowsTaskName: resolveNodeWindowsTaskName(),
  });
}

function buildNodeRuntimeHints(env: NodeJS.ProcessEnv = process.env): string[] {
  return buildPlatformRuntimeLogHints({
    env,
    systemdServiceName: resolveNodeSystemdServiceName(),
    windowsTaskName: resolveNodeWindowsTaskName(),
  });
}

function resolveNodeDefaults(
  opts: NodeDaemonInstallOptions,
  config: Awaited<ReturnType<typeof loadNodeHostConfig>>,
) {
  const host = opts.host?.trim() || config?.gateway?.host || "127.0.0.1";
  const portOverride = parsePort(opts.port);
  if (opts.port !== undefined && portOverride === null) {
    return { host, port: null };
  }
  const port = portOverride ?? config?.gateway?.port ?? 18789;
  return { host, port };
}

export async function runNodeDaemonInstall(opts: NodeDaemonInstallOptions) {
  const json = Boolean(opts.json);
  const { stdout, warnings, emit, fail } = createDaemonActionContext({ action: "install", json });

  if (resolveIsNixMode(process.env)) {
    fail("Nix mode detected; service install is disabled.");
    return;
  }

  const config = await loadNodeHostConfig();
  const { host, port } = resolveNodeDefaults(opts, config);
  if (!Number.isFinite(port ?? NaN) || (port ?? 0) <= 0) {
    fail("Invalid port");
    return;
  }

  const runtimeRaw = opts.runtime ? String(opts.runtime) : DEFAULT_NODE_DAEMON_RUNTIME;
  if (!isNodeDaemonRuntime(runtimeRaw)) {
    fail('Invalid --runtime (use "node" or "bun")');
    return;
  }

  let headers: Record<string, string> | undefined;
  try {
    headers = parseHeaderArgs(opts.header);
  } catch (err) {
    fail(String(err));
    return;
  }
  if (Object.keys(headers).length === 0) {
    headers = undefined;
  }
  if (
    headers === undefined &&
    !hasNodeHeaderEnv(process.env) &&
    config?.gateway?.headers &&
    Object.keys(config.gateway.headers).length > 0
  ) {
    headers = config.gateway.headers;
  }

  const service = resolveNodeService();
  let loaded = false;
  try {
    loaded = await service.isLoaded({ env: process.env });
  } catch (err) {
    fail(`Node service check failed: ${String(err)}`);
    return;
  }
  if (loaded && !opts.force) {
    emit({
      ok: true,
      result: "already-installed",
      message: `Node service already ${service.loadedText}.`,
      service: buildDaemonServiceSnapshot(service, loaded),
      warnings: warnings.length ? warnings : undefined,
    });
    if (!json) {
      defaultRuntime.log(`Node service already ${service.loadedText}.`);
      defaultRuntime.log(`Reinstall with: ${formatCliCommand("openclaw node install --force")}`);
    }
    return;
  }

  const tlsFingerprint = opts.tlsFingerprint?.trim() || config?.gateway?.tlsFingerprint;
  const tls = Boolean(opts.tls) || Boolean(tlsFingerprint) || Boolean(config?.gateway?.tls);
  const { programArguments, workingDirectory, environment, description } =
    await buildNodeInstallPlan({
      env: process.env,
      host,
      port: port ?? 18789,
      tls,
      tlsFingerprint: tlsFingerprint || undefined,
      headers,
      nodeId: opts.nodeId,
      displayName: opts.displayName,
      runtime: runtimeRaw,
      warn: (message) => {
        if (json) {
          warnings.push(message);
        } else {
          defaultRuntime.log(message);
        }
      },
    });

  await installDaemonServiceAndEmit({
    serviceNoun: "Node",
    service,
    warnings,
    emit,
    fail,
    install: async () => {
      await service.install({
        env: process.env,
        stdout,
        programArguments,
        workingDirectory,
        environment,
        description,
      });
    },
  });
}

export async function runNodeDaemonUninstall(opts: NodeDaemonLifecycleOptions = {}) {
  return await runServiceUninstall({
    serviceNoun: "Node",
    service: resolveNodeService(),
    opts,
    stopBeforeUninstall: false,
    assertNotLoadedAfterUninstall: false,
  });
}

export async function runNodeDaemonStart(opts: NodeDaemonLifecycleOptions = {}) {
  return await runServiceStart({
    serviceNoun: "Node",
    service: resolveNodeService(),
    renderStartHints: renderNodeServiceStartHints,
    opts,
  });
}

export async function runNodeDaemonRestart(opts: NodeDaemonLifecycleOptions = {}) {
  await runServiceRestart({
    serviceNoun: "Node",
    service: resolveNodeService(),
    renderStartHints: renderNodeServiceStartHints,
    opts,
  });
}

export async function runNodeDaemonStop(opts: NodeDaemonLifecycleOptions = {}) {
  return await runServiceStop({
    serviceNoun: "Node",
    service: resolveNodeService(),
    opts,
  });
}

export async function runNodeDaemonStatus(opts: NodeDaemonStatusOptions = {}) {
  const json = Boolean(opts.json);
  const service = resolveNodeService();
  const [loaded, command, runtime] = await Promise.all([
    service.isLoaded({ env: process.env }).catch(() => false),
    service.readCommand(process.env).catch(() => null),
    service
      .readRuntime(process.env)
      .catch((err): GatewayServiceRuntime => ({ status: "unknown", detail: String(err) })),
  ]);

  const commandForOutput = redactNodeServiceCommandEnv(command);
  const payload = {
    service: {
      ...buildDaemonServiceSnapshot(service, loaded),
      command: commandForOutput,
      runtime,
    },
  };

  if (json) {
    defaultRuntime.log(JSON.stringify(payload, null, 2));
    return;
  }

  const { rich, label, accent, infoText, okText, warnText, errorText } =
    createCliStatusTextStyles();

  const serviceStatus = loaded ? okText(service.loadedText) : warnText(service.notLoadedText);
  defaultRuntime.log(`${label("Service:")} ${accent(service.label)} (${serviceStatus})`);

  if (commandForOutput?.programArguments?.length) {
    defaultRuntime.log(
      `${label("Command:")} ${infoText(commandForOutput.programArguments.join(" "))}`,
    );
  }
  if (commandForOutput?.sourcePath) {
    defaultRuntime.log(`${label("Service file:")} ${infoText(commandForOutput.sourcePath)}`);
  }
  if (commandForOutput?.workingDirectory) {
    defaultRuntime.log(`${label("Working dir:")} ${infoText(commandForOutput.workingDirectory)}`);
  }

  const runtimeLine = formatRuntimeStatus(runtime);
  if (runtimeLine) {
    const runtimeColor = resolveRuntimeStatusColor(runtime?.status);
    defaultRuntime.log(`${label("Runtime:")} ${colorize(rich, runtimeColor, runtimeLine)}`);
  }

  if (!loaded) {
    defaultRuntime.log("");
    for (const hint of renderNodeServiceStartHints()) {
      defaultRuntime.log(`${warnText("Start with:")} ${infoText(hint)}`);
    }
    return;
  }

  const baseEnv = {
    ...(process.env as Record<string, string | undefined>),
    ...(commandForOutput?.environment ?? undefined),
  };
  const hintEnv = {
    ...baseEnv,
    OPENCLAW_LOG_PREFIX: baseEnv.OPENCLAW_LOG_PREFIX ?? "node",
  } as NodeJS.ProcessEnv;

  if (runtime?.missingUnit) {
    defaultRuntime.error(errorText("Service unit not found."));
    for (const hint of buildNodeRuntimeHints(hintEnv)) {
      defaultRuntime.error(errorText(hint));
    }
    return;
  }

  if (runtime?.status === "stopped") {
    defaultRuntime.error(errorText("Service is loaded but not running."));
    for (const hint of buildNodeRuntimeHints(hintEnv)) {
      defaultRuntime.error(errorText(hint));
    }
  }
}
