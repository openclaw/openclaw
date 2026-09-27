import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import { hasErrnoCode } from "../infra/errno.js";
import { findVerifiedGatewayListenerPidsOnPortSync } from "../infra/gateway-processes.js";
import { inspectPortUsage } from "../infra/ports-inspect.js";
import { mergeProcessEnv } from "../infra/process-env.js";
import {
  getWindowsCmdExePath,
  getWindowsPowerShellExePath,
} from "../infra/windows-install-roots.js";
import { readWindowsPortUsageSync } from "../infra/windows-port-pids.js";
import { WINDOWS_POWERSHELL_COLD_SPAWN_TIMEOUT_MS } from "../infra/windows-powershell-spawn.js";
import { hasCommandProcessCleanupError } from "../process/exec-result.js";
import { spawnWithFallback } from "../process/spawn-utils.js";
import { sleep } from "../utils.js";
import { ABSOLUTE_DEADLINE_EXPIRED, awaitWithinDeadline } from "../utils/absolute-deadline.js";
import { resolveGatewayServiceProbeHosts } from "./gateway-service-probe-hosts.js";
import { formatLine } from "./output.js";
import { execSchtasks } from "./schtasks-exec.js";
import {
  readScheduledTaskCommand,
  resolveStartupEntryPaths,
  resolveTaskName,
  resolveTaskScriptPath,
} from "./schtasks-layout.js";
import {
  findInstalledGatewayChildPid,
  findInstalledProcessPid,
  isNodeHostArgv,
  probeProcessState,
  readWindowsProcessSnapshot,
  resolveGatewayListenerPids,
  readBoundedScheduledTaskProcess,
  resolveListenerBackedScheduledTaskRuntime,
  resolveScheduledTaskCommandPort,
  shouldManageGatewayListenerPort,
  terminateGatewayProcessTree,
} from "./schtasks-process.js";
import {
  probeScheduledTaskExists,
  probeScheduledTaskState,
  ScheduledTaskInspectionError,
} from "./schtasks-state-probe.js";
import { mergeGatewayServiceEnv } from "./service-env-merge.js";
import { resolveServiceManagerEnv } from "./service-process-env.js";
import {
  createServiceRuntimeInspectionFailure,
  type GatewayServiceRuntime,
} from "./service-runtime.js";
import type {
  GatewayServiceCommandConfig,
  GatewayServiceEnv,
  GatewayServiceEnvArgs,
  GatewayServiceReadOptions,
  GatewayServiceRestartResult,
} from "./service-types.js";
import {
  assertGatewayServiceUpdateCurrent,
  isUpdateOwnedGatewayServiceCommand,
} from "./service-update-authority.js";
import { WINDOWS_TASK_SUPERVISOR_FLAG } from "./windows-task-supervisor-contract.js";

export const SCHEDULED_TASK_FALLBACK_POLL_MS = 250;
export const SCHEDULED_TASK_FALLBACK_TIMEOUT_MS = 15_000;

/** Read policy independently of runtime state; unavailable policy is not disabled. */
export async function isScheduledTaskEnabled(args: GatewayServiceEnvArgs): Promise<boolean> {
  const observed = probeScheduledTaskState(
    resolveTaskName(args.env ?? process.env),
    args.timeoutMs,
  );
  if (observed.status !== "found" || typeof observed.enabled !== "boolean") {
    throw new Error("Scheduled Task enable policy could not be inspected.");
  }
  return observed.enabled;
}

export async function assertSchtasksAvailable(): Promise<void> {
  const res = await execSchtasks(["/Query"]);
  if (res.code !== 0) {
    const detail = res.stderr || res.stdout;
    throw new Error(`schtasks unavailable: ${detail || "unknown error"}`.trim());
  }
}

export async function isStartupEntryInstalled(
  env: GatewayServiceEnv,
  deadlineMs?: number,
  requireEffective = false,
): Promise<boolean> {
  if (
    deadlineMs !== undefined &&
    (!Number.isFinite(deadlineMs) || performance.now() >= deadlineMs)
  ) {
    throw new Error("Scheduled Task inspection deadline expired.");
  }
  for (const startupEntryPath of resolveStartupEntryPaths(env)) {
    const installed = await awaitWithinDeadline(
      async () => {
        try {
          await fs.access(startupEntryPath);
          return true;
        } catch (error) {
          if (requireEffective && !hasErrnoCode(error, "ENOENT")) {
            throw error;
          }
          return false;
        }
      },
      deadlineMs,
      () => performance.now(),
    );
    if (installed === ABSOLUTE_DEADLINE_EXPIRED) {
      throw new Error("Scheduled Task inspection deadline expired.");
    }
    if (installed) {
      return true;
    }
  }
  return false;
}

export async function removeStartupEntries(
  env: GatewayServiceEnv,
  stdout: NodeJS.WritableStream,
  assertCurrent?: () => void,
): Promise<void> {
  for (const startupEntryPath of resolveStartupEntryPaths(env)) {
    assertCurrent?.();
    try {
      assertGatewayServiceUpdateCurrent();
      await fs.unlink(startupEntryPath);
      stdout.write(`${formatLine("Removed Windows login item", startupEntryPath)}\n`);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        throw createStartupEntryRemovalError(error);
      }
    }
  }
}

function createStartupEntryRemovalError(error: unknown): Error {
  const code = (error as NodeJS.ErrnoException).code;
  // Native filesystem errors include the private Startup-folder path in their messages.
  return new Error(
    `Windows login item removal failed${code ? ` (${code})` : ""}. Check permissions and retry.`,
    { cause: code ? { code } : undefined },
  );
}

export async function waitForScheduledTaskRunningEvidence(
  env: GatewayServiceEnv,
): Promise<boolean> {
  const deadline = Date.now() + SCHEDULED_TASK_FALLBACK_TIMEOUT_MS;
  while (true) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return false;
    }
    const probe = probeScheduledTaskState(resolveTaskName(env), remaining);
    if (Date.now() >= deadline) {
      return false;
    }
    // Only Scheduler supervision, not an old Startup process, proves takeover.
    if (probe.status === "found" && probe.state === 4) {
      return true;
    }
    await sleep(SCHEDULED_TASK_FALLBACK_POLL_MS);
  }
}

// Ordinary install/control routing retains its best-effort Startup fallback.
export async function isRegisteredScheduledTask(env: GatewayServiceEnv): Promise<boolean> {
  try {
    const res = await execSchtasks(["/Query", "/TN", resolveTaskName(env)]);
    return res.code === 0;
  } catch (error) {
    if (hasCommandProcessCleanupError(error)) {
      throw error;
    }
    return false;
  }
}

export async function launchFallbackTaskScript(
  env: GatewayServiceEnv,
  installedCommand?: GatewayServiceCommandConfig | null,
  assertCurrent?: () => void,
): Promise<void> {
  if (isUpdateOwnedGatewayServiceCommand()) {
    throw new Error(
      "UPDATE_NATIVE_AUTHORITY: update-owned native commands require Task Scheduler; standalone startup fallback is unsupported.",
    );
  }
  const scriptPath = resolveTaskScriptPath(env);
  const command =
    installedCommand === undefined ? await readScheduledTaskCommand(env) : installedCommand;
  if (command?.programArguments.length) {
    // Task inspection intentionally hides the wrapper flag so it can match the
    // inner Gateway. Direct fallback must restore that wrapper or it loses the
    // Job Object owner that terminates the whole Gateway process tree.
    const programArguments =
      command.environment?.OPENCLAW_SERVICE_KIND === "gateway"
        ? [...command.programArguments, WINDOWS_TASK_SUPERVISOR_FLAG]
        : command.programArguments;
    const { child } = await spawnWithFallback({
      assertCurrent,
      argv: programArguments,
      options: {
        cwd: command.workingDirectory || undefined,
        detached: true,
        env: mergeProcessEnv([process.env, command.environment]),
        stdio: "ignore",
        windowsHide: true,
      },
    });
    child.unref();
    return;
  }
  // Preserve native missing-script errors before testing the actual cmd.exe access contract.
  await (await fs.open(scriptPath, "r")).close();
  // libuv uses backup semantics, so privileged Node opens can bypass the DACL that cmd enforces.
  const scriptProbe = spawnSync(
    getWindowsPowerShellExePath(),
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(
        "$ErrorActionPreference='Stop'; [System.IO.File]::OpenRead($env:OPENCLAW_TASK_SCRIPT).Dispose()",
        "utf16le",
      ).toString("base64"),
    ],
    {
      env: { ...resolveServiceManagerEnv(), OPENCLAW_TASK_SCRIPT: scriptPath },
      stdio: "ignore",
      windowsHide: true,
    },
  );
  if (scriptProbe.error) {
    throw scriptProbe.error;
  }
  if (scriptProbe.status !== 0) {
    throw Object.assign(new Error("Windows login item script is not readable"), { code: "EACCES" });
  }
  const { child } = await spawnWithFallback({
    assertCurrent,
    // Node's verbatim /s shell contract preserves inner quotes; percent expansion is nonrecursive.
    argv: [getWindowsCmdExePath(), "/d", "/s", "/v:off", "/c", '""%OPENCLAW_TASK_SCRIPT%""'],
    options: {
      detached: true,
      env: { ...process.env, OPENCLAW_TASK_SCRIPT: scriptPath },
      stdio: "ignore",
      windowsHide: true,
      windowsVerbatimArguments: true,
    },
  });
  child.unref();
}

export async function resolveFallbackRuntime(
  env: GatewayServiceEnv,
  installedCommand?: GatewayServiceCommandConfig | null,
  mode: "observe" | "control" = "observe",
  deadlineMs?: number,
): Promise<GatewayServiceRuntime> {
  if (deadlineMs !== undefined) {
    const observed = await readBoundedScheduledTaskProcess(env, deadlineMs, installedCommand);
    if (observed && performance.now() < deadlineMs) {
      if (observed.pid) {
        return {
          status: "running",
          pid: observed.pid,
          detail: `Matching installed process detected for gateway port ${observed.port}.`,
        };
      }
      // Node hosts connect to the Gateway; its listening port is not their liveness.
      if (!shouldManageGatewayListenerPort(env)) {
        return {
          status: "stopped",
          detail: `Startup-folder login item installed; no node host process detected for gateway port ${observed.port}.`,
        };
      }
      const portState = readWindowsPortUsageSync(observed.port, deadlineMs - performance.now());
      if (performance.now() < deadlineMs && portState === "free") {
        return {
          status: "stopped",
          detail: `Startup-folder login item installed; no gateway process or listener detected for port ${observed.port}.`,
        };
      }
    }
    return {
      status: "unknown",
      detail:
        "Startup-folder login item installed; process ownership or port availability could not be verified within the inspection budget.",
    };
  }
  const command =
    installedCommand === undefined
      ? await readScheduledTaskCommand(env).catch((error: unknown) => {
          if (hasCommandProcessCleanupError(error)) {
            throw error;
          }
          return null;
        })
      : installedCommand;
  const port = resolveScheduledTaskCommandPort(env, command);
  if (!port) {
    return {
      status: "unknown",
      detail: shouldManageGatewayListenerPort(env)
        ? "Startup-folder login item installed; gateway port unknown."
        : "Startup-folder login item installed; node gateway port unknown.",
    };
  }
  const installedArguments = command?.programArguments;
  if (!shouldManageGatewayListenerPort(env)) {
    const snapshot = readWindowsProcessSnapshot();
    if (!snapshot) {
      return {
        status: "unknown",
        detail: `Startup-folder login item installed; could not inspect node host process for gateway port ${port}.`,
      };
    }
    const pid = installedArguments?.length
      ? findInstalledProcessPid(snapshot, port, installedArguments, isNodeHostArgv)
      : null;
    return pid
      ? {
          status: "running",
          pid,
          detail: `Startup-folder login item installed; node host process detected for gateway port ${port}.`,
        }
      : {
          status: "stopped",
          detail: `Startup-folder login item installed; no node host process detected for gateway port ${port}.`,
        };
  }

  const shouldInspectProcess = process.platform === "win32" && Boolean(installedArguments?.length);
  const snapshot = shouldInspectProcess ? readWindowsProcessSnapshot() : null;
  const processPid =
    snapshot && installedArguments
      ? findInstalledGatewayChildPid(snapshot, port, installedArguments)
      : null;
  if (processPid) {
    return {
      status: "running",
      pid: processPid,
      detail: `Startup-folder login item installed; matching gateway process detected for port ${port}.`,
    };
  }
  // Control must match persisted argv; a same-port gateway may belong to another checkout.
  const requireCommandOwnership = mode === "control" && process.platform === "win32";
  if (requireCommandOwnership) {
    if (!installedArguments?.length) {
      return {
        status: "unknown",
        detail: `Startup-folder login item installed; persisted command unavailable for gateway port ${port}.`,
      };
    }
    if (!snapshot) {
      return {
        status: "unknown",
        detail: `Startup-folder login item installed; could not verify the installed process for gateway port ${port}.`,
      };
    }
  }
  const probeHosts = await resolveGatewayServiceProbeHosts({ env, command });
  const diagnostics = await inspectPortUsage(port, { probeHosts }).catch((error: unknown) => {
    if (hasCommandProcessCleanupError(error)) {
      throw error;
    }
    return null;
  });
  if (!diagnostics) {
    return {
      status: "unknown",
      detail: `Startup-folder login item installed; could not inspect port ${port}.`,
    };
  }
  if (diagnostics.status !== "busy") {
    const status =
      diagnostics.status === "free" && !(shouldInspectProcess && !snapshot) ? "stopped" : "unknown";
    return {
      status,
      detail:
        status === "unknown" && diagnostics.status === "free"
          ? `Startup-folder login item installed; no listener detected on port ${port}, but process inspection was unavailable.`
          : `Startup-folder login item installed; no gateway listener detected on port ${port}.`,
    };
  }
  const matchedGatewayPids = resolveGatewayListenerPids(diagnostics.listeners);
  const scopedListenerPids = new Set(diagnostics.listeners.map((listener) => listener.pid));
  const verifiedGatewayPids = findVerifiedGatewayListenerPidsOnPortSync(port, {
    env: mergeGatewayServiceEnv(env, command),
  }).filter((pid) => scopedListenerPids.has(pid));
  const ownedGatewayPids = matchedGatewayPids.length > 0 ? matchedGatewayPids : verifiedGatewayPids;
  if (ownedGatewayPids.length > 0) {
    return requireCommandOwnership
      ? {
          status: "unknown",
          detail: `Startup-folder login item installed; gateway listener on port ${port} does not match the persisted command.`,
        }
      : {
          status: "running",
          pid: ownedGatewayPids[0],
          detail: `Startup-folder login item installed; verified gateway listener detected on port ${port}.`,
        };
  }
  return {
    status: "unknown",
    detail: `Startup-folder login item installed; port ${port} is busy, but the listener is not a verified gateway process.`,
  };
}

export function isScheduledTaskDefinitelyNotRunning(taskName: string): boolean {
  const probe = probeScheduledTaskState(taskName, 5_000);
  if (probe.status !== "found") {
    return false;
  }
  // TASK_STATE_DISABLED and TASK_STATE_READY both prove no instance is queued or running.
  return probe.state === 1 || probe.state === 3;
}

export async function readWindowsStartupFallbackRuntimeForUpdate(
  env: GatewayServiceEnv,
): Promise<GatewayServiceRuntime | null> {
  if (!(await isStartupEntryInstalled(env))) {
    return null;
  }
  const taskExists = probeScheduledTaskExists(resolveTaskName(env));
  if (taskExists === null) {
    throw new Error("Could not verify whether the Windows Scheduled Task exists.");
  }
  return taskExists ? null : resolveFallbackRuntime(env, undefined, "control");
}

const FALLBACK_TAKEOVER_REPROBE_TIMEOUT_MS = 5_000;
const FALLBACK_TAKEOVER_REPROBE_INTERVAL_MS = 250;

export async function waitForFallbackTakeoverRuntime(
  env: GatewayServiceEnv,
  installedCommand: GatewayServiceCommandConfig | null,
  initialRuntime: GatewayServiceRuntime,
  previousRuntime: GatewayServiceRuntime,
): Promise<GatewayServiceRuntime> {
  let runtime = initialRuntime;
  const deadline = Date.now() + FALLBACK_TAKEOVER_REPROBE_TIMEOUT_MS;
  while (runtime.status !== "running" && Date.now() < deadline) {
    await sleep(FALLBACK_TAKEOVER_REPROBE_INTERVAL_MS);
    runtime = await resolveFallbackRuntime(env, installedCommand, "control").catch(
      (err: unknown) => {
        if (hasCommandProcessCleanupError(err)) {
          throw err;
        }
        return {
          status: "unknown",
          detail: `Could not re-inspect the existing Windows login item: ${String(err)}`,
        };
      },
    );
  }
  if (runtime.status === "stopped" && previousRuntime.status === "running") {
    const previousPid = previousRuntime.pid;
    if (!previousPid || probeProcessState(previousPid) !== "missing") {
      return {
        status: "unknown",
        detail: "The previously running Windows login item has not exited cleanly.",
      };
    }
  }
  return runtime;
}

async function resolveControllableFallbackRuntime(
  env: GatewayServiceEnv,
): Promise<GatewayServiceRuntime> {
  const runtime = await resolveFallbackRuntime(env, undefined, "control");
  if (runtime.status === "unknown") {
    throw new Error(runtime.detail ?? "Could not verify Windows login item ownership.");
  }
  return runtime;
}

export async function stopStartupEntry(
  env: GatewayServiceEnv,
  stdout: NodeJS.WritableStream,
  onMutation?: () => void,
  assertCurrent?: () => void,
): Promise<void> {
  const runtime = await resolveControllableFallbackRuntime(env);
  if (runtime.pid) {
    await terminateGatewayProcessTree(runtime.pid, 300, assertCurrent);
  }
  onMutation?.();
  stdout.write(`${formatLine("Stopped Windows login item", resolveTaskName(env))}\n`);
}

export async function terminateInstalledStartupRuntime(
  env: GatewayServiceEnv,
  assertCurrent?: () => void,
): Promise<void> {
  if (!(await isStartupEntryInstalled(env))) {
    return;
  }
  const runtime = await resolveControllableFallbackRuntime(env);
  if (runtime.pid) {
    await terminateGatewayProcessTree(runtime.pid, 300, assertCurrent);
  }
}

export async function restartStartupEntry(
  env: GatewayServiceEnv,
  stdout: NodeJS.WritableStream,
  onMutation?: (kind: "stop" | "restart") => void,
  assertCurrent?: () => void,
): Promise<GatewayServiceRestartResult> {
  const runtime = await resolveControllableFallbackRuntime(env);
  if (runtime.pid) {
    await terminateGatewayProcessTree(runtime.pid, 300, assertCurrent);
    onMutation?.("stop");
  }
  await launchFallbackTaskScript(env, undefined, assertCurrent);
  onMutation?.("restart");
  stdout.write(`${formatLine("Restarted Windows login item", resolveTaskName(env))}\n`);
  return { outcome: "completed" };
}

export async function startStartupEntry(
  env: GatewayServiceEnv,
  stdout: NodeJS.WritableStream,
  onMutation?: () => void,
  assertCurrent?: () => void,
): Promise<void> {
  await launchFallbackTaskScript(env, undefined, assertCurrent);
  onMutation?.();
  stdout.write(`${formatLine("Started Windows login item", resolveTaskName(env))}\n`);
}

export async function isScheduledTaskInstalled(args: GatewayServiceEnvArgs): Promise<boolean> {
  const effectiveEnv = args.env ?? (process.env as GatewayServiceEnv);
  const timeoutMs = args.timeoutMs ?? WINDOWS_POWERSHELL_COLD_SPAWN_TIMEOUT_MS;
  const deadlineMs = performance.now() + timeoutMs;
  const probe = probeScheduledTaskState(resolveTaskName(effectiveEnv), timeoutMs);
  if (probe.status === "unknown") {
    throw new ScheduledTaskInspectionError(probe);
  }
  if (performance.now() >= deadlineMs) {
    throw new ScheduledTaskInspectionError({
      status: "unknown",
      detail: "Scheduled Task inspection deadline expired.",
      timeoutMs: 0,
      diagnostic: { kind: "timeout", timeoutMs: 0 },
    });
  }
  return (
    probe.status === "found" ||
    (await isStartupEntryInstalled(effectiveEnv, deadlineMs, args.requireEffective))
  );
}

export async function readScheduledTaskRuntime(
  env: GatewayServiceEnv = process.env as GatewayServiceEnv,
  opts?: GatewayServiceReadOptions,
): Promise<GatewayServiceRuntime> {
  const deadlineMs = opts?.timeoutMs === undefined ? undefined : performance.now() + opts.timeoutMs;
  const probe = probeScheduledTaskState(resolveTaskName(env), opts?.timeoutMs);
  if (probe.status === "missing") {
    return (await isStartupEntryInstalled(env, deadlineMs, opts?.requireEffective))
      ? resolveFallbackRuntime(env, undefined, "observe", deadlineMs)
      : { status: "stopped", missingUnit: true };
  }
  if (probe.status === "unknown") {
    return {
      ...createServiceRuntimeInspectionFailure(probe.detail, probe.timeoutMs),
      missingUnit: false,
    };
  }
  // State owns current activity; LastTaskResult is history and can describe an older run.
  const status =
    probe.state === 4 ? "running" : probe.state === 1 || probe.state === 3 ? "stopped" : "unknown";
  // A detached/lingering process may outlive its task. Retain exact persisted-argv ownership
  // evidence (including PID) without treating it as proof of Scheduler supervision.
  const installedCommand = opts?.requireLoaded
    ? await readScheduledTaskCommand(env, {
        ...opts,
        timeoutMs: deadlineMs === undefined ? undefined : deadlineMs - performance.now(),
      })
    : undefined;
  const observedRuntime = await resolveListenerBackedScheduledTaskRuntime(
    env,
    deadlineMs,
    installedCommand,
  );
  return {
    ...observedRuntime,
    status: status === "unknown" ? status : (observedRuntime?.status ?? status),
    state: ["Unknown", "Disabled", "Queued", "Ready", "Running"][probe.state ?? 0],
    lastRunTime: probe.lastRunTime,
    lastRunResult: probe.lastRunResult,
  };
}
