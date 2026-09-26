/** Locale-independent Task Scheduler registration and runtime facts. */
import { spawnSync } from "node:child_process";
import { resolvePositiveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { hasErrnoCode, isErrno } from "../infra/errno.js";
import { getWindowsPowerShellExePath } from "../infra/windows-install-roots.js";
import type { ServiceInspectionDiagnostic } from "./service-inspection-error.js";
import { resolveServiceManagerEnv } from "./service-process-env.js";

type ScheduledTaskStateProbe =
  | {
      status: "found";
      state: number | null;
      enabled?: boolean;
      lastRunResult?: string;
      lastRunTime?: string;
    }
  | { status: "missing" }
  | {
      status: "unknown";
      detail: string;
      timeoutMs?: number;
      diagnostic: ServiceInspectionDiagnostic;
    };

// Task Scheduler status probe body. `powershell -EncodedCommand` trips
// Defender's obfuscation heuristic even though this script only reads task
// state, so the body stays a literal string and the task name is passed as
// base64 data on the child's stdin, keeping the spawned command line fixed
// and auditable. See #138224.
const SCHEDULED_TASK_STATE_PROBE_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  "$taskName=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadLine()))",
  "$lookup=$false",
  "try { $service=New-Object -ComObject 'Schedule.Service'; $service.Connect(); $lookup=$true; $task=$service.GetFolder('\\').GetTask($taskName); $lookup=$false } catch { $exception=$_.Exception; while($null -ne $exception.InnerException){$exception=$exception.InnerException}; Write-Output $exception.HResult; if($lookup){exit 1}; exit 2 }",
  // A registered task stays found even when state or optional history cannot be read.
  "$result=@{state=$null}",
  "try { $result.state=[int]$task.State } catch {}",
  // Schedule.Service.GetTask returns IRegisteredTask, not a Get-ScheduledTask CIM object.
  // Its Enabled property is Boolean; missing/non-Boolean data must remain unknown.
  "try { $enabled=$task.Enabled; if($enabled -is [bool]) { $result.enabled=$enabled } } catch {}",
  "try { $result.lastRunResult=[int]$task.LastTaskResult } catch {}",
  "try { $result.lastRunTime=$task.LastRunTime.ToUniversalTime().ToString('o', [Globalization.CultureInfo]::InvariantCulture) } catch {}",
  "$result | ConvertTo-Json -Compress; exit 0",
].join("; ");

export function probeScheduledTaskState(
  taskName: string,
  timeoutMs?: number,
): ScheduledTaskStateProbe {
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs < 1)) {
    return {
      status: "unknown",
      detail: "Scheduled Task inspection deadline expired.",
      timeoutMs: 0,
      diagnostic: { kind: "timeout", timeoutMs: 0 },
    };
  }
  // spawnSync requires an integer; rounding up or using zero would extend the allowance.
  const probeTimeoutMs = resolvePositiveTimerTimeoutMs(timeoutMs, 5_000);
  const probe = spawnSync(
    getWindowsPowerShellExePath(),
    ["-NoProfile", "-NonInteractive", "-Command", SCHEDULED_TASK_STATE_PROBE_SCRIPT],
    {
      env: resolveServiceManagerEnv(),
      encoding: "utf8",
      timeout: probeTimeoutMs,
      // The task name rides on the child's stdin as base64 data, so the command
      // body stays a fixed literal without adding a global environment name.
      input: `${Buffer.from(taskName, "utf8").toString("base64")}\n`,
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
    let snapshot: Record<string, unknown> | undefined;
    try {
      snapshot = asOptionalRecord(JSON.parse(probe.stdout));
    } catch {}
    if (!snapshot) {
      return {
        status: "unknown",
        detail: "Scheduled Task probe returned invalid JSON.",
        diagnostic: { kind: "invalid-response" },
      };
    }
    const { state, enabled, lastRunResult, lastRunTime } = snapshot;
    return {
      status: "found",
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

export function probeScheduledTaskExists(taskName: string, timeoutMs?: number): boolean | null {
  const probe = probeScheduledTaskState(taskName, timeoutMs);
  return probe.status === "found" ? true : probe.status === "missing" ? false : null;
}
