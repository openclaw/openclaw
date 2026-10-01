import { spawnSync } from "node:child_process";
import { hostname } from "node:os";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { isGatewayProtocolResponseError } from "../../packages/gateway-client/src/protocol-request.js";
import { readGatewayOwnerLease } from "../infra/gateway-owner-lease.js";
import { classifyOpenClawArgv } from "../infra/gateway-process-argv.js";
import { GATEWAY_SERVICE_STOP_TIMEOUT_MS } from "../infra/gateway-shutdown-budget.js";
import { tryAcquireGatewayStateOwner } from "../infra/gateway-state-owner.js";
import { inspectPortUsage } from "../infra/ports-inspect.js";
import type { PortListener } from "../infra/ports-types.js";
import { throwSqliteLifecycleErrors } from "../infra/sqlite-lifecycle-errors.js";
import { parseTcpPort, parseTcpPortFromArgs } from "../infra/tcp-port.js";
import { getWindowsSystem32ExePath } from "../infra/windows-install-roots.js";
import { readWindowsProcessArgsSync } from "../infra/windows-port-pids.js";
import { readWindowsProcessStartTimeSync } from "../infra/windows-process-start.js";
import { hasCommandProcessCleanupError } from "../process/exec-result.js";
import { killProcessTree } from "../process/kill-tree.js";
import { createOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
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
import {
  isScheduledTaskSqliteSharingError,
  retryScheduledTaskLeaseRead,
} from "./schtasks-sqlite.js";
import {
  prepareScheduledTaskSettlement,
  type ScheduledTaskSettlement,
} from "./schtasks-state-probe.js";
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
  command?: Partial<Pick<GatewayServiceCommandConfig, "programArguments" | "environment">> | null,
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
  return supervisedPid ?? findInstalledProcessPid(entries, port, installedArguments, () => true);
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
  captureExisting = false,
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
  const owner = await retryScheduledTaskLeaseRead(() => readGatewayOwnerLease({ env: ownerEnv }));
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
  if (captureExisting && owner && pids.length > 0) {
    pids.push(
      ...(await resolveLegacyScheduledTaskOwnedGatewayPids(env, context, command)).filter(
        (pid) => pid !== owner.pid,
      ),
    );
  }
  const starts = new Map<number, number | null>();
  const changed = new Error("Gateway owner changed before terminating the captured process");
  const matchesOwner = (current: NonNullable<typeof owner>, pid?: number) =>
    owner &&
    (pid !== owner.pid || hasCurrentProcessIdentity(current)) &&
    current.owner === owner.owner &&
    current.pid === owner.pid &&
    current.port === owner.port &&
    current.host === owner.host &&
    current.startedAt === owner.startedAt &&
    isTaskSupervisor(current.supervisor);
  return {
    owner,
    pids,
    changed,
    acquireTerminationExclusion() {
      if (process.platform === "win32" && starts.size === 0) {
        for (const pid of pids) {
          starts.set(
            pid,
            pid === owner?.pid
              ? owner.startedAt
              : readWindowsProcessStartTimeSync(pid, 5_000, ownerEnv),
          );
        }
      }
      if (
        owner?.port === port &&
        owner.state !== "dead" &&
        owner.supervisor &&
        !isTaskSupervisor(owner.supervisor)
      ) {
        const { kind, name } = owner.supervisor;
        const label = kind === "external" ? "external supervisor" : `${kind} ${name}`;
        throw new Error(
          `Gateway pid ${owner.pid} on port ${port} belongs to ${label}, not Scheduled Task ${taskName}. Run that supervisor's stop or restart command; the Gateway was left running.`,
        );
      }
      if (pids.length > 0 || (owner && owner.state !== "dead")) {
        return null;
      }
      const exclusion = tryAcquireGatewayStateOwner(resolveOpenClawStateSqlitePath(ownerEnv));
      if (!exclusion) {
        throw new Error(
          "Gateway lifecycle ownership is held without a published identity; leave it running and retry after startup finishes.",
        );
      }
      return exclusion;
    },
    assertOwnerCurrent(this: void, pid?: number) {
      if (
        pid !== undefined &&
        starts.has(pid) &&
        (starts.get(pid) === null ||
          readWindowsProcessStartTimeSync(pid, 5_000, ownerEnv) !== starts.get(pid))
      ) {
        throw changed;
      }
      const current = readGatewayOwnerLease({ env: ownerEnv, current: true });
      // A released lease does not transfer authority over the captured PID incarnation.
      if (!current && (pid === undefined || !owner || starts.has(pid))) {
        return;
      }
      if (!current || !matchesOwner(current, pid)) {
        throw changed;
      }
    },
  };
}

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
  if (process.platform === "win32" && snapshot) {
    // Before a Gateway exists, capture its exact supervisor, which can outlive /End.
    const gatewayPid = findInstalledGatewayChildPid(snapshot, port, installedArguments);
    if (gatewayPid) {
      // Capture only this snapshot; later discovery could adopt a replacement.
      const children = snapshot
        .filter((entry) => getSnapshotProcessId(entry) !== gatewayPid)
        .flatMap((row) => findInstalledGatewayChildPid([row], port, installedArguments) ?? []);
      return [gatewayPid, ...children];
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
  // Per-PID fallback still requires the same port and persisted argv.
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
  // An exact match proves presence; only a complete snapshot can prove absence.
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
  stop?: {
    end: () => Promise<void>;
    restart?: boolean;
    onStopped?: () => void;
    warn: (message: string) => void;
    onSettlement?: (fact: ScheduledTaskSettlement) => void;
    onRecovery?: () => void;
  },
): Promise<number[] | null> {
  const windows = process.platform === "win32";
  const ownership = shouldManageGatewayListenerPort(env)
    ? await resolveScheduledTaskGatewayOwnership(env, context, undefined, true)
    : null;
  if (!ownership) {
    if (stop && windows && shouldManageGatewayListenerPort(env)) {
      throw new Error("Gateway identity unavailable; stop refused and Gateway preserved.");
    }
    await stop?.end();
    return [];
  }
  const exclusion = ownership.acquireTerminationExclusion();
  // Authority checks read shared state while an ownerless Task is excluded.
  // Keep those reads admitted across settlement awaits, then drain before release.
  const resources = exclusion
    ? createOpenClawDatabaseMaintenanceScope({
        assertOwnerCurrent: exclusion.assertCurrent,
        assertDatabaseAccess: exclusion.assertDatabaseAccess,
      })
    : undefined;
  const terminate = async () => {
    const settle = stop && windows ? prepareScheduledTaskSettlement(resolveTaskName(env)) : null;
    try {
      const owner = ownership.owner;
      if (stop && windows && owner && ownership.pids.includes(owner.pid)) {
        let dispatched = false;
        try {
          const { callGatewayCli } = await import("../gateway/call.js");
          await callGatewayCli({
            method: "gateway.stop.request",
            params: { target: { pid: owner.pid, ownerId: owner.owner, port: owner.port } },
            localPortOverride: owner.port,
            sharedStateMode: "read-only",
            allowLocalBackendAuthNone: true,
            requiredMethods: ["gateway.stop.request"],
            assertDispatchCurrent: () => {
              assertGatewayServiceUpdateCurrent();
              assertCurrent?.();
              ownership.assertOwnerCurrent(owner.pid);
              dispatched = true;
            },
          });
        } catch (error) {
          // A lost reply can follow acceptance; only a correlated rejection rules it out.
          if (isGatewayProtocolResponseError(error)) {
            dispatched = false;
          }
        }
        await waitForProcessExit(owner.pid, dispatched ? GATEWAY_SERVICE_STOP_TIMEOUT_MS : 0);
      }
      if (stop && !windows) {
        await stop.end();
      }
      for (const pid of ownership.pids) {
        if (stop && windows && (await waitForProcessExit(pid, 0))) {
          continue;
        }
        await retryScheduledTaskLeaseRead(() => ownership.assertOwnerCurrent(pid));
        await terminateGatewayProcessTree(pid, 300, () => {
          assertCurrent?.();
          ownership.assertOwnerCurrent(pid);
        });
      }
      if (stop && !exclusion) {
        await retryScheduledTaskLeaseRead(ownership.assertOwnerCurrent);
      }
    } catch (error) {
      if (!stop || !ownership.pids.length || !isScheduledTaskSqliteSharingError(error)) {
        throw error;
      }
      for (const pid of ownership.pids) {
        if (!(await waitForProcessExit(pid, 15_000))) {
          throw new Error("Gateway still alive; refusing another state writer.", { cause: error });
        }
      }
      stop.onRecovery?.();
      stop.warn("SQLite owner inspection is locked after stop; continuing with the port check.");
    }
    if (ownership.pids.length > 0) {
      stop?.onStopped?.();
    }
    if (settle && stop) {
      const fact = await settle(() => {
        assertGatewayServiceUpdateCurrent();
        assertCurrent?.();
      }, stop.end);
      stop.onSettlement?.(fact);
      if (fact.status === "replaced") {
        throw ownership.changed;
      }
      if (fact.status === "unavailable") {
        if (!stop.restart || !ownership.pids.length) {
          throw new Error("Task settlement unavailable; stop unverified.", { cause: fact });
        }
        stop.warn("Task settlement unavailable after Gateway exit; attempting /Run.");
      }
    }
    return ownership.pids;
  };
  const errors: unknown[] = [];
  try {
    return await (resources ? resources.run(terminate) : terminate());
  } catch (error) {
    errors.push(error);
    if (!stop || error !== ownership.changed) {
      throw error;
    }
    stop.warn("Gateway replacement or unverified process preserved during stop.");
    return null;
  } finally {
    // Failed drainage is terminal for native CLI control; retain exclusion until process exit.
    try {
      await resources?.close();
      exclusion?.release();
    } catch (error) {
      errors.push(error);
      throwSqliteLifecycleErrors(errors, "Scheduled Task stop and state cleanup failed");
    }
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

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const probe = process.platform === "win32" ? probeWindowsTasklistProcessState : probeProcessState;
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
  // Direct PID probes avoid signaling an exited owner despite a lagging CIM snapshot.
  if (await waitForProcessExit(pid, graceful.status === 0 && !graceful.error ? graceMs : 0)) {
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
  if (!(await waitForProcessExit(pid, WINDOWS_FORCED_PROCESS_EXIT_TIMEOUT_MS))) {
    throw new Error(`gateway process ${pid} exit could not be confirmed after taskkill`);
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
