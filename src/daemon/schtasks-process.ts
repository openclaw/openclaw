import { spawnSync } from "node:child_process";
import { hostname } from "node:os";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { readGatewayOwnerLease } from "../infra/gateway-owner-lease.js";
import { classifyOpenClawArgv } from "../infra/gateway-process-argv.js";
import { inspectPortUsage } from "../infra/ports-inspect.js";
import type { PortListener } from "../infra/ports-types.js";
import { tryAcquireGatewayLifecycleCleanupCoordinator } from "../infra/state-database-coordinator.js";
import { parseTcpPort, parseTcpPortFromArgs } from "../infra/tcp-port.js";
import { getWindowsSystem32ExePath } from "../infra/windows-install-roots.js";
import { readWindowsProcessArgsSync } from "../infra/windows-port-pids.js";
import { readWindowsProcessStartTimeSync } from "../infra/windows-process-start.js";
import { hasCommandProcessCleanupError } from "../process/exec-result.js";
import { killProcessTree } from "../process/kill-tree.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { sleep } from "../utils.js";
import { ABSOLUTE_DEADLINE_EXPIRED, awaitWithinDeadline } from "../utils/absolute-deadline.js";
import { parseCmdScriptCommandLine } from "./cmd-argv.js";
import { NODE_SERVICE_KIND } from "./constants.js";
import { resolveGatewayServiceProbeHosts } from "./gateway-service-probe-hosts.js";
import { readScheduledTaskCommand, resolveTaskName } from "./schtasks-layout.js";
import {
  getSnapshotProcessId,
  isCompleteWindowsProcessSnapshot,
  readWindowsProcessSnapshot,
  type WindowsProcessSnapshotEntry,
} from "./schtasks-process-snapshot.js";
import { mergeGatewayServiceEnv } from "./service-env-merge.js";
import { resolveServiceManagerEnv } from "./service-process-env.js";
import type { GatewayServiceRuntime } from "./service-runtime.js";
import type { GatewayServiceCommandConfig, GatewayServiceEnv } from "./service-types.js";
import { assertGatewayServiceUpdateCurrent } from "./service-update-authority.js";
import {
  readWindowsTaskSupervisorRestartExitCode,
  WINDOWS_TASK_SUPERVISOR_FLAG,
} from "./windows-task-supervisor-contract.js";

export { readWindowsProcessSnapshot } from "./schtasks-process-snapshot.js";

const WINDOWS_FORCED_PROCESS_EXIT_TIMEOUT_MS = 15_000;

export function resolveScheduledTaskCommandPort(
  env: GatewayServiceEnv,
  command?: {
    programArguments?: string[];
    environment?: GatewayServiceEnv;
  } | null,
): number | null {
  return (
    parseTcpPortFromArgs(command?.programArguments) ??
    parseTcpPort(command?.environment?.OPENCLAW_GATEWAY_PORT) ??
    parseTcpPort(env.OPENCLAW_GATEWAY_PORT)
  );
}

export function isNodeHostArgv(programArguments: string[]): boolean {
  const normalized = normalizeProgramArguments(programArguments);
  return normalized.some((arg, index) => arg === "node" && normalized[index + 1] === "run");
}

function normalizeProgramArguments(programArguments: string[]): string[] {
  return programArguments.map((arg) => normalizeLowercaseStringOrEmpty(arg.replaceAll("\\", "/")));
}

function matchesInstalledProgramArguments(
  actualArguments: string[],
  installedArguments: string[],
): boolean {
  const actual = normalizeProgramArguments(actualArguments);
  const installed = normalizeProgramArguments(installedArguments);
  return (
    actual.length === installed.length && actual.every((arg, index) => arg === installed[index])
  );
}

export function findInstalledProcessPid(
  entries: WindowsProcessSnapshotEntry[],
  port: number,
  installedArguments: string[],
  matchesProcess: (argv: string[]) => boolean,
  comparableArguments: (argv: string[]) => string[] = (argv) => argv,
): number | null {
  for (const entry of entries) {
    const commandLine = normalizeLowercaseStringOrEmpty(entry.CommandLine ?? "");
    if (!commandLine) {
      continue;
    }
    const argv = parseCmdScriptCommandLine(entry.CommandLine ?? "");
    if (
      !matchesProcess(argv) ||
      parseTcpPortFromArgs(argv) !== port ||
      !matchesInstalledProgramArguments(comparableArguments(argv), installedArguments)
    ) {
      continue;
    }
    const pid = getSnapshotProcessId(entry);
    if (pid) {
      return pid;
    }
  }
  return null;
}

function matchesInstalledGatewayChildArguments(
  actualArguments: string[],
  installedArguments: string[],
): boolean {
  return (
    readWindowsTaskSupervisorRestartExitCode(actualArguments) !== undefined &&
    matchesInstalledProgramArguments(actualArguments.slice(0, -1), installedArguments)
  );
}

/** Finds the current supervised child or a legacy directly launched Gateway. */
export function findInstalledGatewayChildPid(
  entries: WindowsProcessSnapshotEntry[],
  port: number,
  installedArguments: string[],
): number | null {
  const supervisedPid = findInstalledProcessPid(
    entries,
    port,
    installedArguments,
    (argv) => readWindowsTaskSupervisorRestartExitCode(argv) !== undefined,
    (argv) => argv.slice(0, -1),
  );
  if (supervisedPid) {
    return supervisedPid;
  }
  return findInstalledProcessPid(entries, port, installedArguments, () => true);
}

async function resolveScheduledTaskNodeHostProcess(
  env: GatewayServiceEnv,
  installedCommand?: GatewayServiceCommandConfig | null,
): Promise<{ pid: number; port: number } | null> {
  const command =
    installedCommand === undefined
      ? await readScheduledTaskCommand(env).catch(() => null)
      : installedCommand;
  const installedArguments = command?.programArguments;
  if (!installedArguments?.length) {
    return null;
  }
  const port = resolveScheduledTaskCommandPort(env, command);
  if (!port) {
    return null;
  }
  const snapshot = readWindowsProcessSnapshot();
  if (!snapshot) {
    return null;
  }
  // Match full persisted argv so a same-port OpenClaw process cannot impersonate this task.
  const pid = findInstalledProcessPid(snapshot, port, installedArguments, isNodeHostArgv);
  return pid ? { pid, port } : null;
}

export function shouldManageGatewayListenerPort(env: GatewayServiceEnv): boolean {
  return normalizeLowercaseStringOrEmpty(env.OPENCLAW_SERVICE_KIND) !== NODE_SERVICE_KIND;
}

export async function resolveScheduledTaskGatewayContext(env: GatewayServiceEnv): Promise<{
  port: number | null;
  probeHosts: readonly string[];
}> {
  const command = await readScheduledTaskCommand(env).catch(() => null);
  return {
    port: resolveScheduledTaskCommandPort(env, command),
    probeHosts: await resolveGatewayServiceProbeHosts({ env, command }),
  };
}

export function resolveGatewayListenerPids(listeners: PortListener[]): number[] {
  return Array.from(
    new Set(
      listeners.flatMap((listener) =>
        typeof listener.pid === "number" &&
        listener.commandLine &&
        classifyOpenClawArgv(parseCmdScriptCommandLine(listener.commandLine), {
          command: "gateway",
          pid: listener.pid,
        }).kind === "openclaw"
          ? [listener.pid]
          : [],
      ),
    ),
  );
}

export async function resolveScheduledTaskOwnedGatewayPids(
  env: GatewayServiceEnv,
  context?: { port: number | null; probeHosts?: readonly string[] },
  installedCommand?: GatewayServiceCommandConfig | null,
): Promise<number[]> {
  const ownership = await resolveScheduledTaskGatewayOwnership(env, context, installedCommand);
  return ownership?.pids ?? [];
}

async function resolveScheduledTaskGatewayOwnership(
  env: GatewayServiceEnv,
  context?: { port: number | null; probeHosts?: readonly string[] },
  installedCommand?: GatewayServiceCommandConfig | null,
) {
  const command =
    installedCommand === undefined
      ? await readScheduledTaskCommand(env).catch(() => null)
      : installedCommand;
  const port = context ? context.port : resolveScheduledTaskCommandPort(env, command);
  if (!port) {
    return null;
  }
  const ownerEnv = mergeGatewayServiceEnv(env, command);
  const owner = readGatewayOwnerLease({ env: ownerEnv });
  const taskName = resolveTaskName(env);
  const isTaskSupervisor = (supervisor: NonNullable<typeof owner>["supervisor"]) =>
    supervisor?.kind === "schtasks" && supervisor.name?.toLowerCase() === taskName.toLowerCase();
  const hasCurrentProcessIdentity = (candidate: NonNullable<typeof owner>) =>
    candidate.state === "live" ||
    (candidate.state === "unknown" &&
      candidate.host === hostname() &&
      candidate.startedAt !== null &&
      readWindowsProcessStartTimeSync(candidate.pid, 5_000, ownerEnv) === candidate.startedAt);
  const pids = owner
    ? owner.port === port && hasCurrentProcessIdentity(owner) && isTaskSupervisor(owner.supervisor)
      ? [owner.pid]
      : []
    : await resolveLegacyScheduledTaskOwnedGatewayPids(env, context, command);
  let ownerWasValidatedForTermination = false;
  return {
    pids,
    acquireTerminationExclusion() {
      if (
        owner?.port === port &&
        owner.state !== "dead" &&
        owner.supervisor &&
        !isTaskSupervisor(owner.supervisor)
      ) {
        const supervisor = owner.supervisor;
        const label =
          supervisor.kind === "external"
            ? "external supervisor"
            : `${supervisor.kind} ${supervisor.name ?? "(name unavailable)"}`;
        throw new Error(
          `Gateway pid ${owner.pid} on port ${port} belongs to ${label}, not Scheduled Task ${taskName}. Run that supervisor's stop or restart command; the Gateway was left running.`,
        );
      }
      // Both legacy discovery paths require exact installed argv. Older releases
      // hold the coordinator without publishing a row and remain terminable.
      if (pids.length > 0) {
        return null;
      }
      if (owner) {
        return null;
      }
      const exclusion = tryAcquireGatewayLifecycleCleanupCoordinator({
        databasePath: resolveOpenClawStateSqlitePath(ownerEnv),
      });
      if (!exclusion) {
        throw new Error(
          "Gateway lifecycle ownership is held without a published identity; leave it running and retry after startup finishes.",
        );
      }
      return exclusion;
    },
    assertOwnerCurrent(pid: number) {
      const current = readGatewayOwnerLease({ env: ownerEnv });
      if (!owner && !current) {
        return;
      }
      if (
        owner &&
        !current &&
        ownerWasValidatedForTermination &&
        owner.host === hostname() &&
        owner.startedAt !== null &&
        readWindowsProcessStartTimeSync(pid, 5_000, ownerEnv) === owner.startedAt
      ) {
        // Graceful shutdown removes its published lease before the process has
        // necessarily exited. Keep the already-authorized termination bound to
        // the same local PID incarnation rather than treating cleanup as an
        // ownership transfer.
        return;
      }
      if (
        !owner ||
        !current ||
        current.owner !== owner.owner ||
        current.pid !== pid ||
        current.port !== port ||
        current.host !== owner.host ||
        current.startedAt !== owner.startedAt ||
        !hasCurrentProcessIdentity(current) ||
        !isTaskSupervisor(current.supervisor)
      ) {
        throw new Error(`Gateway owner changed before terminating process ${pid}`);
      }
      ownerWasValidatedForTermination = true;
    },
  };
}

// Full snapshots and per-PID fallback lookups require the same installed-argv attribution.
async function resolveLegacyScheduledTaskOwnedGatewayPids(
  env: GatewayServiceEnv,
  context?: { port: number | null; probeHosts?: readonly string[] },
  installedCommand?: GatewayServiceCommandConfig | null,
): Promise<number[]> {
  const command =
    installedCommand === undefined
      ? await readScheduledTaskCommand(env).catch(() => null)
      : installedCommand;
  const installedArguments = command?.programArguments;
  if (!installedArguments?.length) {
    return [];
  }
  const port = context ? context.port : resolveScheduledTaskCommandPort(env, command);
  if (!port) {
    return [];
  }

  const snapshot = readWindowsProcessSnapshot();
  if (process.platform === "win32") {
    if (snapshot) {
      // Prefer the Gateway PID; before admission its exact supervisor still owns startup.
      // /End can leave that supervisor alive, so stop must find it before a Gateway exists.
      const gatewayPid = findInstalledGatewayChildPid(snapshot, port, installedArguments);
      if (gatewayPid) {
        return [gatewayPid];
      }
      const supervisorPid = findInstalledProcessPid(
        snapshot,
        port,
        [...installedArguments, WINDOWS_TASK_SUPERVISOR_FLAG],
        () => true,
      );
      if (supervisorPid) {
        return [supervisorPid];
      }
      // A listener can be dual-stack or belong to another task; Windows control requires CIM argv proof.
      return [];
    }
  }
  // If the full CIM snapshot is unavailable, per-PID lookups can still prove
  // Windows ownership. Both platforms require the same port and persisted argv.
  const probeHosts =
    context?.probeHosts ?? (await resolveGatewayServiceProbeHosts({ env, command }));
  const diagnostics = await inspectPortUsage(port, { probeHosts }).catch(() => null);
  if (diagnostics?.status !== "busy") {
    return [];
  }
  const ownedPids = new Set<number>();
  const supervisorArguments = [...installedArguments, WINDOWS_TASK_SUPERVISOR_FLAG];
  for (const listener of diagnostics.listeners) {
    if (typeof listener.pid !== "number") {
      continue;
    }
    const argv = listener.commandLine
      ? parseCmdScriptCommandLine(listener.commandLine)
      : process.platform === "win32"
        ? readWindowsProcessArgsSync(listener.pid)
        : null;
    if (!argv || parseTcpPortFromArgs(argv) !== port) {
      continue;
    }
    if (
      matchesInstalledProgramArguments(argv, installedArguments) ||
      (process.platform === "win32" &&
        (matchesInstalledProgramArguments(argv, supervisorArguments) ||
          matchesInstalledGatewayChildArguments(argv, installedArguments)))
    ) {
      ownedPids.add(listener.pid);
    }
  }
  return Array.from(ownedPids);
}

/** Describe remaining listeners when ownership verification fails, for actionable errors. */
export async function describeUnverifiedPortListeners(
  port: number,
  probeHosts?: readonly string[],
): Promise<string> {
  const diagnostics = await inspectPortUsage(port, probeHosts ? { probeHosts } : undefined).catch(
    () => null,
  );
  const listeners = diagnostics?.status === "busy" ? diagnostics.listeners : [];
  if (!listeners || listeners.length === 0) {
    return "";
  }
  const described = listeners.map((listener) => {
    const pid = typeof listener.pid === "number" ? listener.pid : null;
    const argv = listener.commandLine ? parseCmdScriptCommandLine(listener.commandLine) : null;
    const identity = argv
      ? classifyOpenClawArgv(argv, { command: "gateway" }).kind === "openclaw"
        ? "openclaw gateway"
        : "not an openclaw gateway"
      : "argv unavailable";
    const name = listener.command ?? "unknown";
    return pid ? `pid ${pid} (${name}, ${identity})` : `${name} (${identity})`;
  });
  const pids = listeners
    .map((listener) => listener.pid)
    .filter((pid): pid is number => typeof pid === "number");
  const hint = pids.length
    ? ` If one of these is this gateway, stop it with "Stop-Process -Id <pid> -Force" and retry.`
    : "";
  return ` Remaining listener(s): ${described.join(", ")}. If gateway.cmd redirects output, quote the entire redirection target, including environment variables.${hint}`;
}

/** A completed native snapshot distinguishes no match from unavailable inspection. */
export async function readBoundedScheduledTaskProcess(
  env: GatewayServiceEnv,
  deadlineMs: number,
  installedCommand?: GatewayServiceCommandConfig | null,
): Promise<{ port: number; pid: number | null } | null> {
  const remaining = () => {
    const value = deadlineMs - performance.now();
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error("Scheduled Task inspection deadline expired.");
    }
    return value;
  };
  remaining();
  const command =
    installedCommand === undefined
      ? await awaitWithinDeadline(
          // Best-effort command reading only reads/parses the launcher file. Do
          // not race strict native queries or release their children unjoined.
          () =>
            readScheduledTaskCommand(env, { timeoutMs: remaining() }).catch((error: unknown) => {
              if (hasCommandProcessCleanupError(error)) {
                throw error;
              }
              return null;
            }),
          deadlineMs,
          () => performance.now(),
        )
      : installedCommand;
  if (command === ABSOLUTE_DEADLINE_EXPIRED) {
    throw new Error("Scheduled Task inspection deadline expired.");
  }
  remaining();
  const port = resolveScheduledTaskCommandPort(env, command);
  if (!port || !command?.programArguments.length) {
    return null;
  }
  const snapshot = readWindowsProcessSnapshot(remaining());
  remaining();
  if (!snapshot || !snapshot.some((entry) => getSnapshotProcessId(entry) !== null)) {
    return null;
  }
  const pid = shouldManageGatewayListenerPort(env)
    ? findInstalledGatewayChildPid(snapshot, port, command.programArguments)
    : findInstalledProcessPid(snapshot, port, command.programArguments, isNodeHostArgv);
  // A positive exact match survives unrelated unreadable rows. Only a complete
  // snapshot can prove no match; missing argv or PID can conceal this process.
  const complete = pid !== null || isCompleteWindowsProcessSnapshot(snapshot);
  remaining();
  return complete ? { port, pid } : null;
}

export async function resolveListenerBackedScheduledTaskRuntime(
  env: GatewayServiceEnv,
  deadlineMs?: number,
  installedCommand?: GatewayServiceCommandConfig | null,
): Promise<Pick<GatewayServiceRuntime, "status" | "pid" | "detail"> | null> {
  if (deadlineMs !== undefined) {
    // Scheduler state remains authoritative without an exact running process.
    const observed = await readBoundedScheduledTaskProcess(env, deadlineMs, installedCommand);
    return observed?.pid
      ? {
          status: "running",
          pid: observed.pid,
          detail: `Matching installed process detected for gateway port ${observed.port}.`,
        }
      : null;
  }
  if (!shouldManageGatewayListenerPort(env)) {
    const matched = await resolveScheduledTaskNodeHostProcess(env, installedCommand);
    return matched
      ? {
          status: "running",
          pid: matched.pid,
          detail: `Node host process detected for gateway port ${matched.port}.`,
        }
      : null;
  }
  const command =
    installedCommand === undefined
      ? await readScheduledTaskCommand(env).catch(() => null)
      : installedCommand;
  const context = {
    port: resolveScheduledTaskCommandPort(env, command),
  };
  const pids = await resolveScheduledTaskOwnedGatewayPids(env, context, command);
  return pids.length > 0
    ? {
        status: "running",
        pid: pids[0],
        detail: `Gateway process detected for gateway port ${context.port}.`,
      }
    : null;
}

export async function terminateScheduledTaskNodeHost(
  env: GatewayServiceEnv,
  assertCurrent?: () => void,
): Promise<number[]> {
  const matched = await resolveScheduledTaskNodeHostProcess(env);
  if (!matched) {
    return [];
  }
  await terminateGatewayProcessTree(matched.pid, 300, assertCurrent);
  return [matched.pid];
}

export async function terminateScheduledTaskGatewayListeners(
  env: GatewayServiceEnv,
  context?: { port: number | null; probeHosts: readonly string[] },
  assertCurrent?: () => void,
): Promise<number[]> {
  if (!shouldManageGatewayListenerPort(env)) {
    return [];
  }
  const resolvedContext = context ?? (await resolveScheduledTaskGatewayContext(env));
  const port = resolvedContext.port;
  if (!port) {
    return [];
  }
  const ownership = await resolveScheduledTaskGatewayOwnership(env, resolvedContext);
  if (!ownership) {
    return [];
  }
  const exclusion = ownership.acquireTerminationExclusion();
  try {
    for (const pid of ownership.pids) {
      await terminateGatewayProcessTree(pid, 300, () => {
        assertCurrent?.();
        ownership.assertOwnerCurrent(pid);
      });
    }
    return ownership.pids;
  } finally {
    exclusion?.release();
  }
}

export function probeProcessState(pid: number): "alive" | "missing" | "unknown" {
  if (process.platform === "win32") {
    const snapshot = readWindowsProcessSnapshot();
    if (snapshot) {
      return snapshot.some((entry) => getSnapshotProcessId(entry) === pid) ? "alive" : "missing";
    }
    return probeWindowsTasklistProcessState(pid);
  }
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ESRCH" ? "missing" : "unknown";
  }
}

function probeWindowsTasklistProcessState(pid: number): "alive" | "missing" | "unknown" {
  const tasklist = spawnSync(
    getWindowsSystem32ExePath("tasklist.exe"),
    ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"],
    { env: resolveServiceManagerEnv(), encoding: "utf8", timeout: 1_500, windowsHide: true },
  );
  if (tasklist.error || tasklist.status !== 0) {
    return "unknown";
  }
  return tasklist.stdout.split(/\r?\n/).some((line) => line.includes(`,"${pid}",`))
    ? "alive"
    : "missing";
}

async function waitForProcessExit(
  pid: number,
  timeoutMs: number,
  probe: (pid: number) => "alive" | "missing" | "unknown" = probeProcessState,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (probe(pid) === "missing") {
      return true;
    }
    await sleep(100);
  }
  return probe(pid) === "missing";
}

export async function terminateGatewayProcessTree(
  pid: number,
  graceMs: number,
  assertCurrent?: () => void,
): Promise<void> {
  assertGatewayServiceUpdateCurrent();
  assertCurrent?.();
  if (process.platform !== "win32") {
    // These PIDs come from argv/port ownership; leader verification avoids signaling our group.
    killProcessTree(pid, { graceMs });
    return;
  }
  const taskkillPath = getWindowsSystem32ExePath("taskkill.exe");
  const graceful = spawnSync(taskkillPath, ["/T", "/PID", String(pid)], {
    env: resolveServiceManagerEnv(),
    stdio: "ignore",
    timeout: 5_000,
    windowsHide: true,
  });
  // Full CIM snapshots can lag either taskkill. Probe this PID directly so an
  // already-removed owner never reaches the forced-termination authority check.
  if (
    await waitForProcessExit(
      pid,
      graceful.status === 0 && !graceful.error ? graceMs : 0,
      probeWindowsTasklistProcessState,
    )
  ) {
    return;
  }
  assertGatewayServiceUpdateCurrent();
  assertCurrent?.();
  const forced = spawnSync(taskkillPath, ["/F", "/T", "/PID", String(pid)], {
    env: resolveServiceManagerEnv(),
    stdio: "ignore",
    timeout: 5_000,
    windowsHide: true,
  });
  if (forced.error || forced.status !== 0) {
    if (probeProcessState(pid) === "missing") {
      return;
    }
    throw new Error(`taskkill could not terminate gateway process ${pid}`);
  }
  // Verify the forced result through the same direct PID boundary.
  if (
    !(await waitForProcessExit(
      pid,
      WINDOWS_FORCED_PROCESS_EXIT_TIMEOUT_MS,
      probeWindowsTasklistProcessState,
    )) &&
    probeWindowsTasklistProcessState(pid) === "alive"
  ) {
    throw new Error(`gateway process ${pid} is still running after taskkill`);
  }
}

export async function waitForGatewayPortRelease(
  port: number,
  timeoutMs = 5_000,
  options?: { probeHosts?: readonly string[] },
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const diagnostics = await inspectPortUsage(
      port,
      options?.probeHosts ? { probeHosts: options.probeHosts } : undefined,
    ).catch(() => null);
    if (diagnostics?.status === "free") {
      return true;
    }
    await sleep(250);
  }
  return false;
}

export async function assertReplacementPortAvailableForTakeover(params: {
  env: GatewayServiceEnv;
  programArguments: string[];
  environment?: GatewayServiceEnv;
  fallbackPid?: number;
}): Promise<void> {
  if (!shouldManageGatewayListenerPort(params.env)) {
    return;
  }
  const port = resolveScheduledTaskCommandPort(params.env, {
    programArguments: params.programArguments,
    ...(params.environment ? { environment: params.environment } : {}),
  });
  if (!port) {
    throw new Error("Could not verify the replacement Windows Scheduled Task port.");
  }
  const probeHosts = await resolveGatewayServiceProbeHosts({
    env: params.env,
    command: {
      programArguments: params.programArguments,
      ...(params.environment
        ? {
            environment: Object.fromEntries(
              Object.entries(params.environment).filter(
                (entry): entry is [string, string] => typeof entry[1] === "string",
              ),
            ),
          }
        : {}),
    },
  });
  const diagnostics = await inspectPortUsage(port, { probeHosts }).catch(() => null);
  if (!diagnostics) {
    throw new Error(`Could not inspect replacement gateway port ${port}.`);
  }
  if (diagnostics.status === "free") {
    return;
  }
  if (diagnostics.status !== "busy") {
    throw new Error(`Could not verify replacement gateway port ${port}.`);
  }

  const allowedPids = new Set<number>();
  if (params.fallbackPid) {
    allowedPids.add(params.fallbackPid);
  }
  if (process.platform === "win32") {
    const snapshot = readWindowsProcessSnapshot();
    if (snapshot) {
      const replacementPid = findInstalledProcessPid(
        snapshot,
        port,
        params.programArguments,
        () => true,
      );
      if (replacementPid) {
        allowedPids.add(replacementPid);
      }
    }
  }
  const listenerPids = diagnostics.listeners.map((listener) => listener.pid);
  if (
    listenerPids.length > 0 &&
    listenerPids.every((pid) => typeof pid === "number" && pid > 0 && allowedPids.has(pid))
  ) {
    return;
  }
  throw new Error(`replacement gateway port ${port} is occupied by an unverified process`);
}
