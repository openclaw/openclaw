/** Locale-independent Task Scheduler registration and runtime facts. */
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import { resolvePositiveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { hasErrnoCode, isErrno } from "../infra/errno.js";
import { getWindowsPowerShellExePath } from "../infra/windows-install-roots.js";
import { WINDOWS_POWERSHELL_COLD_SPAWN_TIMEOUT_MS } from "../infra/windows-powershell-spawn.js";
import { awaitWithinDeadline } from "../utils/absolute-deadline.js";
import {
  ServiceInspectionError,
  type ServiceInspectionDiagnostic,
} from "./service-inspection-error.js";
import { resolveServiceManagerEnv } from "./service-process-env.js";

export type ScheduledTaskSnapshot = {
  taskPath?: string;
  actions?: Array<{ type: number; path: string; arguments: string; workingDirectory: string }>;
  state: number | null;
  enabled?: boolean;
  lastRunResult?: string;
  lastRunTime?: string;
};

type ScheduledTaskStateProbe =
  | ({ status: "found" } & ScheduledTaskSnapshot)
  | { status: "missing" }
  | {
      status: "unknown";
      detail: string;
      timeoutMs?: number;
      diagnostic: ServiceInspectionDiagnostic;
    };

export class ScheduledTaskInspectionError extends ServiceInspectionError {
  readonly timeoutMs?: number;

  constructor(probe: Extract<ScheduledTaskStateProbe, { status: "unknown" }>) {
    super("windows-task-inspection-failed", probe.diagnostic);
    this.name = "ScheduledTaskInspectionError";
    this.timeoutMs = probe.diagnostic.kind === "timeout" ? probe.diagnostic.timeoutMs : undefined;
  }
}

const READ_TASK = [
  "function Read-Task($task) {",
  "$result=@{taskPath=[string]$task.Path;state=$null}",
  "try { $result.state=[int]$task.State } catch {}",
  "try { $enabled=$task.Enabled; if($enabled -is [bool]) { $result.enabled=$enabled } } catch {}",
  "try { $result.lastRunResult=[int]$task.LastTaskResult } catch {}",
  "try { $result.lastRunTime=$task.LastRunTime.ToUniversalTime().ToString('o', [Globalization.CultureInfo]::InvariantCulture) } catch {}",
  "try { $result.actions=@(foreach($action in $task.Definition.Actions) { if([int]$action.Type -eq 0) { @{type=0;path=[string]$action.Path;arguments=[string]$action.Arguments;workingDirectory=[string]$action.WorkingDirectory} } else { @{type=[int]$action.Type;path='';arguments='';workingDirectory=''} } }) } catch {}",
  "$result }",
].join("; ");

function queryTaskScheduler(
  taskName: string | undefined,
  timeoutMs?: number,
): { status: "ok"; value: unknown } | Exclude<ScheduledTaskStateProbe, { status: "found" }> {
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs < 1)) {
    return {
      status: "unknown",
      detail: "Scheduled Task inspection deadline expired.",
      timeoutMs: 0,
      diagnostic: { kind: "timeout", timeoutMs: 0 },
    };
  }
  // spawnSync requires an integer; rounding up or using zero would extend the allowance.
  const probeTimeoutMs = resolvePositiveTimerTimeoutMs(
    timeoutMs,
    WINDOWS_POWERSHELL_COLD_SPAWN_TIMEOUT_MS,
  );
  const encodedTaskName = Buffer.from(taskName ?? "", "utf8").toString("base64");
  const script = [
    "$ErrorActionPreference='Stop'",
    "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)",
    `$taskName=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedTaskName}'))`,
    "$lookup=$false",
    READ_TASK,
    "try { $service=New-Object -ComObject 'Schedule.Service'; $service.Connect() } catch { Write-Output $_.Exception.HResult; exit 2 }",
    taskName === undefined
      ? "function Read-Folder($folder) { foreach($task in $folder.GetTasks(1)) { Read-Task $task }; foreach($child in $folder.GetFolders(0)) { Read-Folder $child } }; try { $tasks=@(Read-Folder ($service.GetFolder('\\'))); ConvertTo-Json -InputObject $tasks -Depth 4 -Compress; exit 0 } catch { Write-Output $_.Exception.HResult; exit 2 }"
      : "try { $lookup=$true; $task=$service.GetFolder('\\').GetTask($taskName); $lookup=$false; Read-Task $task | ConvertTo-Json -Depth 4 -Compress; exit 0 } catch { $exception=$_.Exception; while($null -ne $exception.InnerException){$exception=$exception.InnerException}; Write-Output $exception.HResult; if($lookup){exit 1}; exit 2 }",
  ].join("; ");
  const probe = spawnSync(
    getWindowsPowerShellExePath(),
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    {
      env: resolveServiceManagerEnv(),
      encoding: "utf8",
      timeout: probeTimeoutMs,
      // CREATE_NO_WINDOW makes Windows PowerShell 5.1 fail without output on some hosts.
      windowsHide: false,
    },
  );
  if (probe.error) {
    if (hasErrnoCode(probe.error, "ETIMEDOUT")) {
      return {
        status: "unknown",
        detail: `Scheduled Task probe timed out after ${probeTimeoutMs} ms (ETIMEDOUT).`,
        timeoutMs: probeTimeoutMs,
        diagnostic: { kind: "timeout", timeoutMs: probeTimeoutMs },
      };
    }
    return {
      status: "unknown",
      detail: probe.error.message,
      diagnostic: {
        kind: "spawn",
        ...(isErrno(probe.error) &&
        typeof probe.error.errno === "number" &&
        Number.isSafeInteger(probe.error.errno)
          ? { errno: probe.error.errno }
          : {}),
      },
    };
  }
  if (probe.status === 0) {
    try {
      return { status: "ok", value: JSON.parse(probe.stdout) };
    } catch {}
    return {
      status: "unknown",
      detail: "Scheduled Task probe returned invalid JSON.",
      diagnostic: { kind: "invalid-response" },
    };
  }
  const hresult = Number(probe.stdout.trim());
  // Only a missing task/folder during lookup proves absence, not a failed COM connection.
  return probe.status === 1 && (hresult === -2147024894 || hresult === -2147024893)
    ? { status: "missing" }
    : {
        status: "unknown",
        detail: `Scheduled Task probe failed (exit ${probe.status}): ${probe.stdout.trim() || probe.stderr.trim() || "no output from PowerShell."}`,
        diagnostic: {
          kind: "native",
          exitCode: probe.status,
          ...(/^-?\d+$/.test(probe.stdout.trim()) &&
          Number.isInteger(hresult) &&
          hresult >= -0x80000000 &&
          hresult <= 0x7fffffff
            ? { hresult }
            : {}),
        },
      };
}

function readTaskSnapshot(value: unknown): ScheduledTaskSnapshot | undefined {
  const snapshot = asOptionalRecord(value);
  if (!snapshot) {
    return undefined;
  }
  const { taskPath, actions, state, enabled, lastRunResult, lastRunTime } = snapshot;
  let parsedActions: ScheduledTaskSnapshot["actions"];
  if (Array.isArray(actions)) {
    parsedActions = [];
    for (const rawAction of actions) {
      const action = asOptionalRecord(rawAction);
      const { type, path, arguments: args, workingDirectory } = action ?? {};
      if (
        typeof type !== "number" ||
        typeof path !== "string" ||
        typeof args !== "string" ||
        typeof workingDirectory !== "string"
      ) {
        parsedActions = undefined;
        break;
      }
      parsedActions.push({ type, path, arguments: args, workingDirectory });
    }
  }
  return {
    ...(typeof taskPath === "string" && taskPath ? { taskPath } : {}),
    ...(parsedActions ? { actions: parsedActions } : {}),
    state:
      typeof state === "number" && Number.isInteger(state) && state >= 0 && state <= 4
        ? state
        : null,
    ...(typeof enabled === "boolean" ? { enabled } : {}),
    ...(typeof lastRunResult === "number" && Number.isInteger(lastRunResult)
      ? { lastRunResult: String(lastRunResult) }
      : {}),
    ...(typeof lastRunTime === "string" ? { lastRunTime } : {}),
  };
}

export function probeScheduledTaskState(
  taskName: string,
  timeoutMs?: number,
): ScheduledTaskStateProbe {
  const result = queryTaskScheduler(taskName, timeoutMs);
  if (result.status !== "ok") {
    return result;
  }
  const snapshot = readTaskSnapshot(result.value);
  return snapshot
    ? { status: "found", ...snapshot }
    : {
        status: "unknown",
        detail: "Scheduled Task probe returned invalid JSON.",
        diagnostic: { kind: "invalid-response" },
      };
}

export async function isScheduledTaskDefinitionAbsent({
  taskName,
  resolveDefinitionPaths,
  deadline,
}: {
  taskName: string;
  resolveDefinitionPaths: () => readonly string[];
  deadline?: number;
}): Promise<boolean> {
  const remainingTimeout = () =>
    deadline === undefined ? undefined : deadline - performance.now();
  const expired = () => deadline !== undefined && performance.now() >= deadline;
  if (expired()) {
    return false;
  }
  // A missing script can still belong to a registered task or Startup login item.
  const probe = probeScheduledTaskState(taskName, remainingTimeout());
  if (probe.status === "unknown") {
    throw new ScheduledTaskInspectionError(probe);
  }
  if (probe.status !== "missing" || expired()) {
    return false;
  }
  for (const pathname of resolveDefinitionPaths()) {
    if (expired()) {
      return false;
    }
    const absent = await awaitWithinDeadline(
      async () => {
        try {
          await fs.lstat(pathname);
          return false;
        } catch (error) {
          return hasErrnoCode(error, "ENOENT");
        }
      },
      deadline,
      () => performance.now(),
    );
    if (absent !== true) {
      return false;
    }
  }
  if (expired()) {
    return false;
  }
  const current = probeScheduledTaskState(taskName, remainingTimeout());
  if (current.status === "unknown") {
    throw new ScheduledTaskInspectionError(current);
  }
  return current.status === "missing" && !expired();
}

export function listScheduledTasks(timeoutMs?: number): ScheduledTaskSnapshot[] {
  const result = queryTaskScheduler(undefined, timeoutMs);
  if (result.status === "ok" && Array.isArray(result.value)) {
    const tasks = result.value.map(readTaskSnapshot);
    if (tasks.every((task) => task?.taskPath)) {
      return tasks.filter((task): task is ScheduledTaskSnapshot => task !== undefined);
    }
  }
  if (result.status === "unknown") {
    throw new ScheduledTaskInspectionError(result);
  }
  throw new Error("Scheduled Task inventory could not be inspected.");
}

export function probeScheduledTaskExists(taskName: string, timeoutMs?: number): boolean | null {
  const probe = probeScheduledTaskState(taskName, timeoutMs);
  return probe.status === "found" ? true : probe.status === "missing" ? false : null;
}
