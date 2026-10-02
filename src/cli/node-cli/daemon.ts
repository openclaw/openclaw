// Node-host daemon lifecycle commands for install, status, start, stop, and restart.
import { colorize } from "../../../packages/terminal-core/src/theme.js";
import {
  resolveGatewayDaemonRuntime,
  isGatewayDaemonRuntime,
} from "../../commands/daemon-runtime.js";
import { buildNodeInstallPlan } from "../../commands/node-daemon-install-helpers.js";
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
import {
  resolvePinnedDaemonRuntimePath,
  resolveRecordedDaemonRuntime,
} from "../../daemon/runtime-paths.js";
import { readDaemonRuntimePinForInstall } from "../../daemon/runtime-pin-state.js";
import type { GatewayServiceRuntime } from "../../daemon/service-runtime.js";
import { resolveManagedGatewayServiceCommand } from "../../daemon/service-types.js";
import {
  isSystemdUserServiceAvailable,
  readSystemdUserLingerStatus,
  resolveSystemdUserServiceAccount,
} from "../../daemon/systemd.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { loadNodeHostConfig } from "../../node-host/config.js";
import { defaultRuntime } from "../../runtime.js";
import { formatCliCommand } from "../command-format.js";
import {
  runServiceRestart,
  runServiceStart,
  runServiceStop,
  runServiceUninstall,
} from "../daemon-cli/lifecycle-core.js";
import { buildDaemonServiceSnapshot, installDaemonServiceAndEmit } from "../daemon-cli/response.js";
import {
  createCliStatusTextStyles,
  createDaemonInstallActionContext,
  resolveDaemonInstallBlockMessage,
  formatRuntimeStatus,
  projectDaemonServiceForJson,
  resolveRuntimeStatusColor,
} from "../daemon-cli/shared.js";
import { formatInvalidConfigPort, formatInvalidPortOption } from "../error-format.js";
import { resolveNodeGatewayOptions } from "./gateway-options.js";

type NodeDaemonInstallOptions = Parameters<typeof resolveNodeGatewayOptions>[0] & {
  nodeId?: string;
  displayName?: string;
  shareInstalledApps?: boolean;
  commands?: string[];
  allCommands?: boolean;
  runtime?: string;
  runtimePath?: string;
  force?: boolean;
  json?: boolean;
};

type NodeDaemonOutputOptions = {
  json?: boolean;
};

function renderNodeServiceStartHints(): string[] {
  return buildPlatformServiceStartHints({
    installHint: formatCliCommand("openclaw node install"),
    startCommand: formatCliCommand("openclaw node start"),
    launchAgentPlistPath: `~/Library/LaunchAgents/${resolveNodeLaunchAgentLabel()}.plist`,
    systemdServiceName: resolveNodeSystemdServiceName(),
    windowsTaskName: resolveNodeWindowsTaskName(),
  });
}

/**
 * User-level node services stop with the last SSH session unless lingering is enabled.
 * Diagnose this without changing the operator's login policy.
 */
async function warnIfSystemdUserLingerDisabled(warn: (message: string) => void): Promise<void> {
  if (process.platform !== "linux") {
    return;
  }
  if (!(await isSystemdUserServiceAvailable())) {
    return;
  }
  const user = resolveSystemdUserServiceAccount(process.env);
  if (!user) {
    return;
  }
  const status = await readSystemdUserLingerStatus({ env: process.env, user });
  if (!status || status.linger === "yes") {
    return;
  }
  warn(
    `Systemd lingering is disabled for ${status.user}. The node service will stop when you log out. Run: sudo loginctl enable-linger ${status.user}`,
  );
}

export async function runNodeDaemonInstall(opts: NodeDaemonInstallOptions) {
  const { json, stdout, warnings, warn, emit, emitMessage, fail } =
    createDaemonInstallActionContext(opts.json);
  const installBlock = resolveDaemonInstallBlockMessage("node");
  if (installBlock) {
    fail(installBlock);
    return;
  }

  const config = await loadNodeHostConfig();
  let gatewayOptions;
  try {
    gatewayOptions = resolveNodeGatewayOptions(opts, config);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    return;
  }
  const { host, port, contextPath, tls, tlsFingerprint, cloudflareAccess } = gatewayOptions;
  if (port === null || !Number.isFinite(port) || port <= 0 || port > 65_535) {
    fail(
      opts.port !== undefined
        ? formatInvalidPortOption("--port")
        : formatInvalidConfigPort("node.gateway.port"),
    );
    return;
  }
  if (opts.tls === false && opts.tlsFingerprint !== undefined) {
    fail("--no-tls cannot be combined with --tls-fingerprint");
    return;
  }
  if (cloudflareAccess && tls !== true) {
    fail("Cloudflare Access credentials require --tls for the node Gateway connection");
    return;
  }

  const service = resolveNodeService();
  let existingServiceCommand;
  try {
    existingServiceCommand = await service.readCommand(process.env);
  } catch (error) {
    fail(`Node service inspection failed: ${formatErrorMessage(error)}`);
    return;
  }
  const existingManagedCommand = resolveManagedGatewayServiceCommand(existingServiceCommand);
  const installEnv: NodeJS.ProcessEnv = {
    ...process.env,
    OPENCLAW_WRAPPER:
      process.env.OPENCLAW_WRAPPER ?? existingManagedCommand?.environment?.OPENCLAW_WRAPPER,
  };
  let pinSnapshot;
  try {
    pinSnapshot = readDaemonRuntimePinForInstall(
      { kind: "node", env: installEnv },
      existingServiceCommand,
      opts.runtime !== undefined || opts.runtimePath !== undefined,
    );
  } catch (error) {
    fail(`Runtime pin inspection failed: ${formatErrorMessage(error)}`);
    return;
  }
  let pinnedRuntimePath = opts.runtimePath ?? (opts.runtime ? undefined : pinSnapshot.pin?.path);
  const runtimeRaw = opts.runtime || resolveGatewayDaemonRuntime([pinnedRuntimePath ?? ""]);
  if (!isGatewayDaemonRuntime(runtimeRaw)) {
    fail('Invalid --runtime (use "node" or "bun")');
    return;
  }

  try {
    if (!installEnv.OPENCLAW_WRAPPER?.trim() || opts.runtimePath !== undefined) {
      pinnedRuntimePath = await resolvePinnedDaemonRuntimePath(
        pinnedRuntimePath,
        runtimeRaw,
        installEnv,
      );
    }
  } catch (error) {
    fail(`Invalid runtime pin: ${formatErrorMessage(error)}`);
    return;
  }
  let loaded;
  try {
    loaded = await service.isLoaded({ env: process.env });
  } catch (err) {
    fail(`Node service check failed: ${formatErrorMessage(err)}`);
    return;
  }
  if (loaded && !opts.force) {
    await warnIfSystemdUserLingerDisabled(warn);
    emitMessage({
      ok: true,
      result: "already-installed",
      message: `Node service already ${service.loadedText}.`,
      service: buildDaemonServiceSnapshot(service, loaded),
      warnings: warnings.length ? warnings : undefined,
    });
    if (!json) {
      defaultRuntime.log(`Reinstall with: ${formatCliCommand("openclaw node install --force")}`);
    }
    return;
  }

  const recordedRuntime =
    opts.runtime === undefined && !pinnedRuntimePath && !installEnv.OPENCLAW_WRAPPER?.trim()
      ? await resolveRecordedDaemonRuntime(existingManagedCommand?.programArguments[0], installEnv)
      : undefined;
  const retainedRuntime = recordedRuntime?.status === "supported" ? recordedRuntime : undefined;

  const { programArguments, workingDirectory, environment, environmentValueSources, description } =
    await buildNodeInstallPlan({
      env: installEnv,
      host,
      port,
      contextPath,
      tls: Boolean(tls),
      tlsFingerprint,
      nodeId: opts.nodeId,
      displayName: opts.displayName,
      installedAppsSharing: opts.shareInstalledApps,
      commands: opts.commands,
      allCommands: opts.allCommands,
      runtime: retainedRuntime?.runtime ?? runtimeRaw,
      runtimeExplicit: opts.runtime !== undefined || opts.runtimePath !== undefined,
      runtimePath: retainedRuntime?.path,
      pinnedRuntimePath,
      warn,
    });

  await installDaemonServiceAndEmit({
    serviceNoun: "Node",
    service,
    warnings,
    emit,
    fail,
    install: async () => {
      await service.install({
        runtimePinUpdate: {
          expected: pinSnapshot,
          pin: pinnedRuntimePath ? { runtime: runtimeRaw, path: pinnedRuntimePath } : undefined,
        },
        env: installEnv,
        stdout,
        warn,
        programArguments,
        workingDirectory,
        environment,
        environmentValueSources,
        description,
      });
    },
    // Failed installation must not carry a misleading linger warning (#107033).
    onVerified: () => warnIfSystemdUserLingerDisabled(warn),
  });
}

export async function runNodeDaemonUninstall(opts: NodeDaemonOutputOptions = {}) {
  return await runServiceUninstall({
    serviceNoun: "Node",
    service: resolveNodeService(),
    opts,
    stopBeforeUninstall: false,
    assertNotLoadedAfterUninstall: false,
  });
}

export async function runNodeDaemonStart(opts: NodeDaemonOutputOptions = {}) {
  return await runServiceStart({
    serviceNoun: "Node",
    service: resolveNodeService(),
    renderStartHints: renderNodeServiceStartHints,
    opts,
  });
}

export async function runNodeDaemonRestart(opts: NodeDaemonOutputOptions = {}) {
  await runServiceRestart({
    serviceNoun: "Node",
    service: resolveNodeService(),
    renderStartHints: renderNodeServiceStartHints,
    opts,
  });
}

export async function runNodeDaemonStop(opts: NodeDaemonOutputOptions = {}) {
  return await runServiceStop({
    serviceNoun: "Node",
    service: resolveNodeService(),
    opts,
  });
}

export async function runNodeDaemonStatus(opts: NodeDaemonOutputOptions = {}) {
  const json = Boolean(opts.json);
  const service = resolveNodeService();
  let loaded: boolean;
  try {
    loaded = await service.isLoaded({ env: process.env });
  } catch (error) {
    const message = `Node service check failed: ${formatErrorMessage(error)}`;
    if (json) {
      throw new Error(message, { cause: error });
    }
    defaultRuntime.error(message);
    defaultRuntime.exit(1);
    return;
  }
  const [command, runtime] = await Promise.all([
    service.readCommand(process.env).catch(() => null),
    service.readRuntime(process.env).catch((err: unknown): GatewayServiceRuntime => ({
      status: "unknown",
      detail: formatErrorMessage(err),
    })),
  ]);

  if (json) {
    defaultRuntime.writeJson({
      service: projectDaemonServiceForJson(
        { ...buildDaemonServiceSnapshot(service, loaded), command, runtime },
        { includeDefinitionPaths: true },
      ),
    });
    return;
  }

  const { rich, label, accent, infoText, okText, warnText, errorText } =
    createCliStatusTextStyles();

  const serviceStatus = loaded ? okText(service.loadedText) : warnText(service.notLoadedText);
  defaultRuntime.log(`${label("Service:")} ${accent(service.label)} (${serviceStatus})`);

  if (command?.programArguments?.length) {
    defaultRuntime.log(`${label("Command:")} ${infoText(command.programArguments.join(" "))}`);
  }
  if (command?.sourcePath) {
    defaultRuntime.log(`${label("Service file:")} ${infoText(command.sourcePath)}`);
  }
  if (command?.workingDirectory) {
    defaultRuntime.log(`${label("Working dir:")} ${infoText(command.workingDirectory)}`);
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
    ...process.env,
    ...command?.environment,
  };
  const hintEnv = {
    ...baseEnv,
    OPENCLAW_LOG_PREFIX: baseEnv.OPENCLAW_LOG_PREFIX ?? "node",
  };

  if (runtime?.missingUnit || runtime?.status === "stopped") {
    defaultRuntime.error(
      errorText(
        runtime.missingUnit ? "Service unit not found." : "Service is loaded but not running.",
      ),
    );
    for (const hint of buildPlatformRuntimeLogHints({
      env: hintEnv,
      systemdServiceName: resolveNodeSystemdServiceName(),
      windowsTaskName: resolveNodeWindowsTaskName(),
    })) {
      defaultRuntime.log(errorText(hint));
    }
  }
}
