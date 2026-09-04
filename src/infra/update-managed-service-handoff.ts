// Managed-service update handoff starts a detached process that can finish an
// update after the gateway exits under launchd/systemd-style supervisors.
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import { Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { formatCliCommand } from "../cli/command-format.js";
import { formatInstallationTargetCommand } from "../cli/installation-target-format.js";
import { resolveUpdatedInstallCommandEnv } from "../cli/update-cli/update-command-service-env.js";
import type { TriageFailureContext } from "../commands/triage-prompt.js";
import { resolveGatewayWindowsTaskName } from "../daemon/constants.js";
import { resolveLaunchAgentLabel } from "../daemon/launchd-label.js";
import { resolveLaunchAgentPlistPath } from "../daemon/launchd-service-files.js";
import { resolveServiceManagerEnv } from "../daemon/service-process-env.js";
import { findInstalledSystemdGatewayScope } from "../daemon/systemd-scope.js";
import { resolveSystemdServiceName } from "../daemon/systemd-service-files.js";
import { buildCliRespawnPlan } from "../entry.respawn.js";
import { forceKillChildProcessTree } from "../process/child-process-tree.js";
import { isPidAlive } from "../shared/pid-alive.js";
import { SKIPPED_UPDATE_OUTCOMES } from "../shared/update-outcome.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { isInternalMessageChannel } from "../utils/message-channel.js";
import { resolveExecutableFromPathEnv } from "./executable-path.js";
import { installationTargetEnv, resolveInstallationTarget } from "./installation-target-context.js";
import { resolveNodeSqliteLocation } from "./node-sqlite.js";
import type { GatewayRestartIntent } from "./restart-intent.js";
import { SUPERVISOR_HINT_ENV_VARS, type RespawnSupervisor } from "./supervisor-markers.js";
import type { UpdateChannel } from "./update-channels.js";
import {
  CONTROL_PLANE_UPDATE_SENTINEL_META_ENV,
  type ControlPlaneUpdateSentinelMetaFile,
} from "./update-control-plane-sentinel.js";
import { applyDevUpdateTargetEnv, type DevUpdateTarget } from "./update-dev-target.js";
import { verifyPackageUpdateRecovery } from "./update-global.js";
import { resolveUpdateInstallRoot } from "./update-install-root.js";
import { MANAGED_SERVICE_UPDATE_HANDOFF_TEMP_PREFIX } from "./update-managed-service-handoff-cleanup.js";
import {
  createManagedHandoffLeaseStore,
  readManagedServiceUpdateHandoffLease,
  readManagedHandoffProcessStartTime as getFileLockProcessStartTime,
  resolveManagedUpdateLeaseDatabasePath,
  type ManagedHandoffLease,
} from "./update-managed-service-handoff-lease.js";
import { stageManagedHandoffRuntime } from "./update-managed-service-handoff-runtime.js";
import { HANDOFF_SCRIPT } from "./update-managed-service-handoff-script.js";
import type { UpdateRestartSentinelMeta } from "./update-restart-sentinel-payload.js";
import { readCurrentGitUpdateRecovery } from "./update-runner-git-recovery.js";
import { looksLikeGitCheckout } from "./update-runner-install-surface.js";

// The helper deadline covers scheduled restart delay, the full Gateway drain
// budget, and its bounded parent-exit shutdown reserve. (#99666)
const PARENT_EXIT_SHUTDOWN_RESERVE_MS = 30_000;
const HANDOFF_READY_TIMEOUT_MS = 30_000;
const HANDOFF_READY_MARKER = "OPENCLAW_UPDATE_HANDOFF_READY\n";
const HANDOFF_BUSY_MARKER = "HANDOFF_BUSY ";
const SERVICE_IDENTITY_ENV_VARS = new Set<string>([
  "OPENCLAW_LAUNCHD_LABEL",
  "OPENCLAW_SYSTEMD_UNIT",
  "OPENCLAW_WINDOWS_TASK_NAME",
] as const);
type HandoffChild = ChildProcess & {
  stdin: NonNullable<ChildProcess["stdin"]>;
  stdout: NonNullable<ChildProcess["stdout"]>;
};
type ManagedServiceUpdateHandoffParams = {
  root: string;
  timeoutMs?: number;
  restartDrainTimeoutMs: number;
  restartDelayMs?: number;
  channel?: UpdateChannel;
  tag?: string;
  acceptCapabilities?: boolean;
  meta: UpdateRestartSentinelMeta;
  requester?: { channel?: string; accountId?: string; senderId?: string };
  handoffId?: string;
  supervisor?: RespawnSupervisor | null;
  env?: NodeJS.ProcessEnv;
  devTarget?: DevUpdateTarget;
  execPath?: string;
  argv1?: string;
  parentPid?: number;
  invocationCwd?: string;
  action?: {
    kind: "triage";
    failure: TriageFailureContext;
    entrypoint: string;
    nodeRunner: string;
  };
};

type ManagedServiceUpdateHandoffResult = {
  pid?: number;
  command: string;
  logPath: string;
} & (
  | { status: "started"; handoffId: string; installRoot: string }
  | { status: "joined"; handoffId?: string }
);

type ActiveManagedServiceUpdateHandoff = {
  handoffId: string;
  flight?: Promise<ManagedServiceUpdateHandoffResult>;
  launcher?: HandoffChild;
  launcherStartIdentity?: number | null;
  helper?: ManagedHandoffLease;
  claimed?: boolean;
  cancelling?: boolean;
  exited?: boolean;
};
const activeManagedServiceUpdateHandoffs = new Map<string, ActiveManagedServiceUpdateHandoff>();

function resolveUpdateCliArgv(params: {
  timeoutMs?: number;
  channel?: UpdateChannel;
  tag?: string;
  acceptCapabilities?: boolean;
  execPath?: string;
  argv1?: string;
}): string[] {
  const updateArgs = ["update", "--yes", "--json"];
  if (params.acceptCapabilities) {
    updateArgs.push("--accept-capabilities");
  }
  if (params.channel) {
    updateArgs.push("--channel", params.channel);
  }
  if (params.tag) {
    updateArgs.push("--tag", params.tag);
  }
  if (typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs)) {
    updateArgs.push("--timeout", String(Math.max(1, Math.ceil(params.timeoutMs / 1000))));
  }

  return resolveManagedServiceCliArgv(params, updateArgs);
}

function resolveManagedServiceCliArgv(
  params: { execPath?: string; argv1?: string },
  args: string[],
): string[] {
  const execPath = params.execPath?.trim();
  const argv1 = params.argv1?.trim();
  if (execPath && argv1) {
    return [execPath, argv1, ...args];
  }
  if (execPath && !/^(?:node|bun)(?:\.exe)?$/iu.test(path.basename(execPath))) {
    return [execPath, ...args];
  }
  return ["openclaw", ...args];
}

export function formatManagedServiceUpdateCommand(
  params?: {
    timeoutMs?: number;
    channel?: UpdateChannel;
    tag?: string;
    acceptCapabilities?: boolean;
  },
  env: NodeJS.ProcessEnv = process.env,
): string {
  return formatCliCommand(
    resolveUpdateCliArgv(params ?? {})
      .toSpliced(3, 1)
      .join(" "),
    env,
  );
}

type GatewayServiceRecovery =
  | { kind: "systemd"; unit: string }
  | { kind: "launchd"; uid: number; label: string; plistPath: string }
  | { kind: "schtasks"; taskName: string };

function resolveGatewayServiceRecovery(
  supervisor: RespawnSupervisor | null | undefined,
  env: NodeJS.ProcessEnv,
): GatewayServiceRecovery | undefined {
  if (supervisor === "systemd") {
    return { kind: "systemd", unit: `${resolveSystemdServiceName(env)}.service` };
  }
  if (supervisor === "launchd") {
    const label = resolveLaunchAgentLabel(env);
    const uid = typeof process.getuid === "function" ? process.getuid() : 501;
    return { kind: "launchd", uid, label, plistPath: resolveLaunchAgentPlistPath(env) };
  }
  if (supervisor === "schtasks") {
    const taskName =
      env.OPENCLAW_WINDOWS_TASK_NAME?.trim() || resolveGatewayWindowsTaskName(env.OPENCLAW_PROFILE);
    return { kind: "schtasks", taskName };
  }
  return undefined;
}

function waitForHandoffResponse(child: HandoffChild, command?: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const output = child.stdout;
    let settled = false;
    let buffered = "";
    const finish = (result: string | Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      child.removeListener("error", finish);
      child.removeListener("exit", onExit);
      output.removeListener("data", onData);
      output.removeListener("error", onOutputError);
      child.stdin.removeListener("error", finish).removeListener("close", onInputClose);
      if (result instanceof Error) {
        if (!command) {
          output.destroy();
        }
        reject(result);
      } else {
        resolve(result);
      }
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      finish(
        new Error(
          `managed update handoff exited before ${command ? "responding" : "signaling readiness"} (code=${code ?? "null"}, signal=${signal ?? "null"})`,
        ),
      );
    };
    const onOutputError = (err: Error) => {
      if (!command && child.pid) {
        // A loaded helper is armed even when its readiness marker was lost.
        forceKillChildProcessTree(child);
      }
      finish(err);
    };
    const onInputClose = () => finish(new Error("managed update handoff control input closed"));
    const onData = (chunk: Buffer | string) => {
      buffered = `${buffered}${chunk.toString()}`.slice(-1024);
      const newline = buffered.indexOf("\n");
      if (newline >= 0) {
        finish(buffered.slice(0, newline));
      }
    };
    const timeout = setTimeout(() => {
      const phase = command ? "respond" : "signal readiness";
      onOutputError(new Error(`managed update handoff did not ${phase} within 30 seconds`));
    }, HANDOFF_READY_TIMEOUT_MS);

    child.once("error", finish).once("exit", onExit);
    output.once("error", onOutputError).on("data", onData);
    child.stdin.once("error", finish).once("close", onInputClose);
    if (command) {
      child.stdin.write(`${command}\n`, (error) => {
        if (error) {
          finish(error);
        }
      });
    }
  });
}

async function spawnManagedServiceUpdateHandoff(
  params: ManagedServiceUpdateHandoffParams & { handoffId: string },
  rootIdentity: string,
  owner: ActiveManagedServiceUpdateHandoff,
): Promise<ManagedServiceUpdateHandoffResult> {
  const parentPid = params.parentPid ?? process.pid;
  const parentStartIdentity = getFileLockProcessStartTime(parentPid);
  if (parentStartIdentity === null) {
    throw new Error("managed update parent process start identity is unavailable");
  }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), MANAGED_SERVICE_UPDATE_HANDOFF_TEMP_PREFIX));
  const scriptPath = path.join(dir, "handoff.cjs");
  const paramsPath = path.join(dir, "handoff.json");
  const metaPath = path.join(dir, "sentinel-meta.json");
  const triageInputPath = path.join(dir, "update-failure.json");
  const serviceEnv = params.env ?? process.env;
  const installationTarget = resolveInstallationTarget(serviceEnv);
  const triageContextPath = path.join(
    installationTarget.stateDir,
    "logs",
    "support",
    `openclaw-update-failure-${randomUUID()}.json`,
  );
  const logPath = path.join(dir, "handoff.log");
  const commandArgv = params.action
    ? [params.action.nodeRunner, params.action.entrypoint, "triage"]
    : resolveUpdateCliArgv({
        acceptCapabilities: params.acceptCapabilities,
        timeoutMs: params.timeoutMs,
        channel: params.channel,
        tag: params.tag,
        execPath: params.execPath ?? process.execPath,
        argv1: params.argv1 ?? process.argv[1],
      });
  const commandLabel = params.action
    ? "openclaw triage (automatic)"
    : formatManagedServiceUpdateCommand(
        {
          timeoutMs: params.timeoutMs,
          channel: params.channel,
          tag: params.tag,
          acceptCapabilities: params.acceptCapabilities,
        },
        params.env,
      );
  const metaFile: ControlPlaneUpdateSentinelMetaFile = {
    version: 1,
    meta: { ...params.meta, root: rootIdentity, triageContextPath },
  };
  let spawnCommand = params.execPath ?? process.execPath;
  const spawnArgs = [scriptPath, paramsPath];
  let scopeUnit: string | undefined;
  let systemdRunPath: string | undefined;
  if (params.supervisor === "systemd") {
    const systemdRun = resolveExecutableFromPathEnv(
      "systemd-run",
      [serviceEnv.PATH ?? "", "/usr/bin", "/bin"].join(path.delimiter),
      serviceEnv,
    );
    if (!systemdRun) {
      throw new Error("systemd-run is required to launch a transient user scope");
    }
    systemdRunPath = systemdRun;
    const normalized = params.handoffId.trim().replace(/[^A-Za-z0-9_.:@-]+/gu, "-");
    const suffix =
      normalized.replace(/^-+|-+$/gu, "").slice(0, 80) || `${process.pid}-${Date.now()}`;
    scopeUnit = `openclaw-${params.action ? "triage" : "update"}-${suffix}.scope`;
    spawnArgs.unshift(
      "--user",
      "--scope",
      "--collect",
      `--unit=${scopeUnit}`,
      ...(params.action
        ? [`--property=PartOf=${resolveSystemdServiceName(serviceEnv)}.service`]
        : []),
      spawnCommand,
    );
    spawnCommand = systemdRun;
  }
  const stateDatabasePath = resolveOpenClawStateSqlitePath(serviceEnv);
  const parentExitTimeoutMs = Math.min(
    2_147_483_647,
    Math.max(0, params.restartDelayMs ?? 0) +
      Math.max(0, params.restartDrainTimeoutMs) +
      PARENT_EXIT_SHUTDOWN_RESERVE_MS,
  );
  const childEnv: NodeJS.ProcessEnv = {
    ...serviceEnv,
    // Resolve relative/default target selectors before entering the helper scratch directory.
    ...installationTargetEnv(resolveInstallationTarget(serviceEnv)),
    [CONTROL_PLANE_UPDATE_SENTINEL_META_ENV]: metaPath,
    OPENCLAW_UPDATE_RUN_HANDOFF: "1",
  };
  for (const key of SUPERVISOR_HINT_ENV_VARS) {
    if (!SERVICE_IDENTITY_ENV_VARS.has(key)) {
      delete childEnv[key];
    }
  }
  const preparedEnv = resolveUpdatedInstallCommandEnv({
    processEnv: childEnv,
    invocationCwd: process.cwd(),
  });
  const nodeCommand =
    commandArgv[0] === process.execPath ||
    /^(?:node|bun)(?:\.exe)?$/iu.test(path.basename(commandArgv[0] ?? ""));
  const startup = nodeCommand
    ? buildCliRespawnPlan({
        argv: commandArgv,
        env: preparedEnv,
        execArgv: [],
        execPath: commandArgv[0],
      })
    : null;
  const nodeExecArgv = nodeCommand
    ? (startup?.argv.slice(0, startup.argv.length - commandArgv.length + 1) ?? [])
    : undefined;
  if (startup) {
    commandArgv[0] = startup.command;
  }
  const readyEnv = startup?.env ?? preparedEnv;
  const env = params.devTarget ? applyDevUpdateTargetEnv(readyEnv, params.devTarget) : readyEnv;

  const helperParams = {
    serviceManagerEnv: resolveServiceManagerEnv(serviceEnv),
    nodeExecArgv,
    action: params.action?.kind ?? "update",
    failure: params.action?.failure,
    scopeUnit,
    systemdRun: systemdRunPath,
    requester:
      params.requester?.channel && !isInternalMessageChannel(params.requester.channel)
        ? params.requester
        : undefined,
    parentPid,
    parentStartIdentity: String(parentStartIdentity),
    parentExitTimeoutMs,
    parentExitDeadlineAt: Date.now() + parentExitTimeoutMs,
    cwd: dir,
    invocationCwd: params.invocationCwd,
    commandArgv,
    recoveryCommandArgv: resolveManagedServiceCliArgv(
      { execPath: params.execPath ?? process.execPath, argv1: params.argv1 ?? process.argv[1] },
      ["gateway", "restart", "--preserve-definition", "--json"],
    ),
    recoveryTimeoutMs: params.timeoutMs ?? 30 * 60_000,
    triageCommandArgv: resolveManagedServiceCliArgv(
      { execPath: params.execPath ?? process.execPath, argv1: params.argv1 ?? process.argv[1] },
      ["triage", "--json", "--non-interactive"],
    ),
    triageContextPath,
    triageInputPath,
    triageContextCommand: formatInstallationTargetCommand(
      ["openclaw", "triage", "--update-result", triageContextPath],
      installationTarget,
      { env: serviceEnv },
    ),
    triageRecoveryCommand: formatInstallationTargetCommand(
      ["openclaw", "triage"],
      installationTarget,
      { env: serviceEnv },
    ),
    // This hint becomes a model/channel notice; host paths remain in the helper log.
    triageHint:
      "Update triage runs after service recovery; see the managed update helper log for the outcome and the installation-specific openclaw triage command.",
    commandLabel,
    handoffId: params.handoffId,
    nonFailureSkippedReasons: Object.keys(SKIPPED_UPDATE_OUTCOMES),
    logPath,
    metaPath,
    stateDatabasePath,
    nodeSqliteLocation: resolveNodeSqliteLocation(stateDatabasePath),
    updateLeaseDatabasePath: resolveManagedUpdateLeaseDatabasePath(),
    updateLeaseKey: rootIdentity,
    updateLeaseOwner: params.handoffId,
    sensitivePaths: [scriptPath, paramsPath, metaPath, triageInputPath],
    serviceRecovery: resolveGatewayServiceRecovery(params.supervisor, serviceEnv),
    recovery: await ((await looksLikeGitCheckout(rootIdentity))
      ? readCurrentGitUpdateRecovery(rootIdentity)
      : verifyPackageUpdateRecovery(rootIdentity)),
    recoveryModulePath: path.join(rootIdentity, "dist", "cli", "daemon-cli.js"),
  };

  let child!: HandoffChild;
  let readiness!: string;
  const onExit = () => {
    // Keep exact ownership until cancellation proves the durable lease was released.
    owner.exited = true;
  };
  try {
    helperParams.sensitivePaths.push(...stageManagedHandoffRuntime(dir));
    await fs.writeFile(scriptPath, `${HANDOFF_SCRIPT}\n`, { mode: 0o700 });
    await fs.writeFile(paramsPath, `${JSON.stringify(helperParams, null, 2)}\n`, { mode: 0o600 });
    await fs.writeFile(metaPath, `${JSON.stringify(metaFile, null, 2)}\n`, { mode: 0o600 });

    child = spawn(spawnCommand, spawnArgs, {
      cwd: dir,
      env,
      detached: true,
      stdio: ["pipe", "pipe", "ignore"],
    });
    owner.launcher = child;
    child.stdin.on("error", () => child.stdin.destroy()).once("close", () => child.stdin.destroy());
    // Failed spawn handles are not processes and must never be signalled.
    if (!child.pid) {
      await once(child, "spawn");
    }
    owner.launcherStartIdentity = child.pid ? getFileLockProcessStartTime(child.pid) : null;
    if (owner.launcherStartIdentity == null) {
      forceKillChildProcessTree(child);
      throw new Error("managed update handoff process start identity is unavailable");
    }
    child.once("exit", onExit);
    // systemd-run execs the helper in its scope. Readiness binds its exact
    // lease; triage additionally verifies native cancellation before replying.
    readiness = await waitForHandoffResponse(child);
    if (`${readiness}\n` !== HANDOFF_READY_MARKER && !readiness.startsWith(HANDOFF_BUSY_MARKER)) {
      throw new Error("managed update handoff returned an invalid readiness response");
    }
    if (`${readiness}\n` === HANDOFF_READY_MARKER) {
      const helper = readManagedServiceUpdateHandoffLease(rootIdentity);
      if (
        helper?.owner !== params.handoffId ||
        helper.executor.pid !== helper.helper.pid ||
        helper.executor.startIdentity !== helper.helper.startIdentity ||
        helper.action.kind !== (params.action?.kind ?? "update") ||
        (helper.action.kind === "triage" &&
          (helper.action.lifetime.kind !== "native" ||
            helper.action.lifetime.placement.kind !== "attached" ||
            helper.action.phase !== "reserved")) ||
        !isPidAlive(helper.executor.pid) ||
        getFileLockProcessStartTime(helper.executor.pid)?.toString() !==
          helper.executor.startIdentity
      ) {
        forceKillChildProcessTree(child);
        throw new Error("managed update handoff helper lease identity is unavailable");
      }
      owner.helper = helper;
    }
  } catch (err) {
    child?.removeListener("exit", onExit);
    child?.stdin.destroy();
    child?.stdout.destroy();
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
  child.unref();

  const result = { command: commandLabel, logPath };
  const handoffId = readiness.slice(HANDOFF_BUSY_MARKER.length).trim();
  return `${readiness}\n` === HANDOFF_READY_MARKER
    ? {
        ...result,
        status: "started",
        ...(child.pid ? { pid: child.pid } : {}),
        handoffId: params.handoffId,
        installRoot: rootIdentity,
      }
    : {
        ...result,
        status: "joined",
        ...(handoffId ? { handoffId } : {}),
      };
}

export async function startManagedServiceUpdateHandoff(
  params: ManagedServiceUpdateHandoffParams,
): Promise<ManagedServiceUpdateHandoffResult> {
  if (params.action && params.supervisor !== "systemd") {
    throw new Error(
      "Automatic managed triage requires a Linux user-systemd scope; run openclaw triage manually.",
    );
  }
  if (
    !Number.isFinite(params.restartDrainTimeoutMs) ||
    !Number.isFinite(params.restartDelayMs ?? 0)
  ) {
    throw new Error("managed update handoff requires a finite restart deadline");
  }
  if (
    params.supervisor === "systemd" &&
    (await findInstalledSystemdGatewayScope(params.env ?? process.env))?.scope === "system"
  ) {
    throw new Error(
      "Managed update handoff requires a user-scope systemd unit; perform a manual system-service update.",
    );
  }
  const root = resolveUpdateInstallRoot(params.root);
  const active = activeManagedServiceUpdateHandoffs.get(root);
  if (active?.flight && (!active.exited || active.claimed || active.cancelling)) {
    const joined = await active.flight;
    return {
      status: "joined",
      command: joined.command,
      logPath: joined.logPath,
      ...(joined.pid ? { pid: joined.pid } : {}),
      ...(joined.handoffId ? { handoffId: joined.handoffId } : {}),
    };
  }
  const owner: ActiveManagedServiceUpdateHandoff = { handoffId: params.handoffId ?? randomUUID() };
  activeManagedServiceUpdateHandoffs.set(root, owner);
  const flight = spawnManagedServiceUpdateHandoff(
    {
      ...params,
      handoffId: owner.handoffId,
      meta: {
        ...params.meta,
        handoffId: params.meta.handoffId ?? owner.handoffId,
      },
    },
    root,
    owner,
  );
  owner.flight = flight;
  try {
    return await flight;
  } catch (err) {
    if (activeManagedServiceUpdateHandoffs.get(root) === owner) {
      activeManagedServiceUpdateHandoffs.delete(root);
    }
    throw err;
  }
}

export function claimManagedServiceUpdateHandoff(
  identity: NonNullable<GatewayRestartIntent["successorOwner"]>,
): boolean {
  const root = resolveUpdateInstallRoot(identity.installRoot);
  const active = activeManagedServiceUpdateHandoffs.get(root);
  const launcher = active?.launcher;
  const helper = active?.helper;
  const lease = readManagedServiceUpdateHandoffLease(root);
  if (
    identity.kind !== "managed-update-handoff" ||
    active?.handoffId !== identity.handoffId ||
    !launcher?.pid ||
    !isPidAlive(launcher.pid) ||
    active.launcherStartIdentity == null ||
    getFileLockProcessStartTime(launcher.pid) !== active.launcherStartIdentity ||
    launcher.exitCode !== null ||
    launcher.signalCode !== null ||
    active.cancelling ||
    lease?.owner !== identity.handoffId ||
    helper?.owner !== identity.handoffId ||
    lease.executor.pid !== helper.executor.pid ||
    lease.executor.startIdentity !== helper.executor.startIdentity ||
    JSON.stringify(lease.helper) !== JSON.stringify(helper.helper) ||
    JSON.stringify(lease.action) !== JSON.stringify(helper.action) ||
    (lease.action.kind === "triage" && lease.action.phase !== "reserved") ||
    !isPidAlive(lease.executor.pid) ||
    getFileLockProcessStartTime(lease.executor.pid)?.toString() !== lease.executor.startIdentity
  ) {
    return false;
  }
  active.claimed = true;
  return true;
}

function sendManagedServiceUpdateHandoffCommand(
  identity: NonNullable<GatewayRestartIntent["successorOwner"]>,
  command: string,
): Promise<string | null> {
  const child = activeManagedServiceUpdateHandoffs.get(
    resolveUpdateInstallRoot(identity.installRoot),
  )?.launcher;
  if (!child?.stdin || !child.stdout || child.stdin.destroyed) {
    return Promise.resolve(null);
  }
  return waitForHandoffResponse(child, command).catch(() => null);
}

export async function requestManagedServiceUpdateHandoffPark(
  identity: NonNullable<GatewayRestartIntent["successorOwner"]>,
): Promise<boolean> {
  return (
    claimManagedServiceUpdateHandoff(identity) &&
    (await sendManagedServiceUpdateHandoffCommand(identity, "park")) === "parked" &&
    claimManagedServiceUpdateHandoff(identity)
  );
}

export async function commitManagedServiceUpdateHandoff(
  identity: NonNullable<GatewayRestartIntent["successorOwner"]>,
  outcome: "update" | "restore" = "update",
): Promise<boolean> {
  return (
    claimManagedServiceUpdateHandoff(identity) &&
    (await sendManagedServiceUpdateHandoffCommand(
      identity,
      outcome === "update" ? "commit" : "restore-commit",
    )) === "committed"
  );
}

export async function transferManagedServiceUpdateHandoff(
  identity: NonNullable<GatewayRestartIntent["successorOwner"]>,
): Promise<boolean> {
  const child = activeManagedServiceUpdateHandoffs.get(
    resolveUpdateInstallRoot(identity.installRoot),
  )?.launcher;
  if (
    !(child?.stdin instanceof Socket) ||
    !(child.stdout instanceof Socket) ||
    !claimManagedServiceUpdateHandoff(identity) ||
    (await sendManagedServiceUpdateHandoffCommand(identity, "transfer")) !== "transferred" ||
    !claimManagedServiceUpdateHandoff(identity)
  ) {
    return false;
  }
  // Node's spawn pipe streams are net.Socket instances. Unref keeps the control
  // channel open until CLI exit, so its result is printed before service stop.
  child.stdin.unref();
  child.stdout.unref();
  return true;
}

export async function cancelManagedServiceUpdateHandoff(
  identity: NonNullable<GatewayRestartIntent["successorOwner"]>,
): Promise<"restored-in-process" | "restart-after-exit" | false> {
  const root = resolveUpdateInstallRoot(identity.installRoot);
  const active = activeManagedServiceUpdateHandoffs.get(root);
  if (
    identity.kind !== "managed-update-handoff" ||
    active?.handoffId !== identity.handoffId ||
    active.cancelling
  ) {
    return false;
  }
  active.cancelling = true;
  try {
    const current = readManagedServiceUpdateHandoffLease(root);
    if (current?.action.kind === "triage") {
      if (
        current.owner !== active.handoffId ||
        JSON.stringify(current.helper) !== JSON.stringify(active.helper?.helper) ||
        JSON.stringify({ ...current.action, phase: "reserved" }) !==
          JSON.stringify(active.helper?.action) ||
        !createManagedHandoffLeaseStore().stopNative(current)
      ) {
        return false;
      }
    }
    const child = active.launcher;
    if (child && !active.exited && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
      });
      const response = await sendManagedServiceUpdateHandoffCommand(identity, "cancel");
      if (response === "restore-after-exit") {
        return "restart-after-exit";
      }
      if (response !== "cancelled" && !active.exited && !child.stdin.destroyed) {
        return false;
      }
      await exited;
    }
    if (
      readManagedServiceUpdateHandoffLease(root, active) !== null ||
      activeManagedServiceUpdateHandoffs.get(root) !== active
    ) {
      return false;
    }
    activeManagedServiceUpdateHandoffs.delete(root);
    return "restored-in-process";
  } catch {
    return false;
  } finally {
    active.cancelling = false;
  }
}

export function buildManagedServiceHandoffUnavailableMessage(command: string): string {
  return [
    "OpenClaw updates cannot safely run inside the live gateway process without a managed-service handoff.",
    `Stop the foreground Gateway, run \`${command}\` from a shell, then launch the Gateway again. For a managed deployment, use its host's stop, update, and restart workflow.`,
  ].join("\n");
}
