// Native task/process inspection and sanitized proof rendering.
import { spawnSync } from "node:child_process";
import os from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { expect } from "vitest";
import { getWindowsPowerShellExePath } from "../infra/windows-install-roots.js";
import { setScheduledTaskXmlEnabled } from "./schtasks-control.js";
import { execSchtasks } from "./schtasks-exec.js";
import { probeScheduledTaskExists } from "./schtasks-state-probe.js";
import type { GatewayServiceRuntime } from "./service-runtime.js";

const WAIT_INTERVAL_MS = 200;
const WAIT_TIMEOUT_MS = 30_000;
const TASK_STATE_READY = 3;

export const DIAGNOSTIC_TEXT_LIMIT = 16_384;
const DIAGNOSTIC_PROCESS_LIMIT = 32;
export const TASK_LOGON_INTERACTIVE_TOKEN = 3;
export const TASK_RUNLEVEL_LEAST_PRIVILEGE = 0;

export type ScheduledTaskPrincipal = {
  enabled: boolean;
  lastRunTime: string;
  lastTaskResult: number;
  logonType: number;
  runLevel: number;
  taskState: number;
};

export type WindowsProcessDiagnostic = {
  CommandLine?: string | null;
  CreationDate?: string | null;
  UserModeTime?: number | string;
  KernelModeTime?: number | string;
  ReadOperationCount?: number | string;
  WriteOperationCount?: number | string;
  OtherOperationCount?: number | string;
  ParentProcessId?: number;
  ProcessId?: number;
};

export async function readTaskXml(taskName: string): Promise<string | null> {
  const result = await execSchtasks(["/Query", "/TN", taskName, "/XML"]);
  return result.code === 0
    ? result.stdout.replace(/^\uFEFF/u, "").replaceAll(String.fromCharCode(0), "")
    : null;
}

type TaskDefinitionSnapshot = { exists: false; taskXml: null } | { exists: true; taskXml: string };

export async function readTaskDefinitionSnapshot(
  taskName: string,
): Promise<TaskDefinitionSnapshot> {
  const exists = probeScheduledTaskExists(taskName);
  if (exists === null) {
    throw new Error(`Could not determine whether Scheduled Task ${taskName} exists`);
  }
  if (!exists) {
    return { exists: false, taskXml: null };
  }
  const taskXml = await readTaskXml(taskName);
  if (!taskXml) {
    throw new Error(`Could not export Scheduled Task XML for ${taskName}`);
  }
  return { exists: true, taskXml };
}

export function disableScheduledTaskXmlForFixture(xml: string): string {
  return setScheduledTaskXmlEnabled(xml, false).replace(
    /(<Settings(?:\s[^>]*)?>)([\s\S]*?)(<\/Settings>)/iu,
    (_match, open: string, body: string, close: string) => {
      const field = /<AllowStartOnDemand>\s*(true|false)\s*<\/AllowStartOnDemand>/iu;
      const disabled = "<AllowStartOnDemand>false</AllowStartOnDemand>";
      return `${open}${field.test(body) ? body.replace(field, disabled) : `${disabled}${body}`}${close}`;
    },
  );
}

export function normalizeScheduledTaskXmlEnabledForFixture(xml: string): string {
  // COM exports omit Enabled=true and place an explicit false in schema order.
  // Normalize only that setting and its line; every other definition byte remains checked.
  return setScheduledTaskXmlEnabled(xml, false).replace(
    /(<Settings(?:\s[^>]*)?>)([\s\S]*?)(<\/Settings>)/iu,
    (_match, open: string, body: string, close: string) =>
      `${open}<Enabled>false</Enabled>${body.replace(/(?:\r?\n[\t ]*)?<Enabled>false<\/Enabled>/u, "")}${close}`,
  );
}

export function readTaskPrincipal(taskName: string): ScheduledTaskPrincipal {
  const encodedTaskName = Buffer.from(taskName, "utf8").toString("base64");
  const script = [
    "$ErrorActionPreference='Stop'",
    `$taskName=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedTaskName}'))`,
    "$service=New-Object -ComObject 'Schedule.Service'",
    "$service.Connect()",
    "$task=$service.GetFolder('\\').GetTask($taskName)",
    "$principal=$task.Definition.Principal",
    "$result=@{enabled=[bool]$task.Enabled;logonType=[int]$principal.LogonType;runLevel=[int]$principal.RunLevel;taskState=[int]$task.State;lastTaskResult=[int64]$task.LastTaskResult;lastRunTime=$task.LastRunTime.ToUniversalTime().ToString('o')}",
    "[Console]::Out.Write(($result | ConvertTo-Json -Compress))",
  ].join("; ");
  const result = spawnSync(
    getWindowsPowerShellExePath(),
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    { encoding: "utf8", timeout: 5_000, windowsHide: true },
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `Could not inspect Scheduled Task principal for ${taskName}: ${
        result.stderr.trim() || `PowerShell exited ${result.status ?? "without status"}`
      }`,
    );
  }
  const parsed = JSON.parse(result.stdout.trim()) as Partial<ScheduledTaskPrincipal>;
  if (
    typeof parsed.enabled !== "boolean" ||
    typeof parsed.logonType !== "number" ||
    !Number.isInteger(parsed.logonType) ||
    typeof parsed.runLevel !== "number" ||
    !Number.isInteger(parsed.runLevel) ||
    typeof parsed.taskState !== "number" ||
    !Number.isInteger(parsed.taskState) ||
    typeof parsed.lastTaskResult !== "number" ||
    !Number.isInteger(parsed.lastTaskResult) ||
    typeof parsed.lastRunTime !== "string"
  ) {
    throw new Error(`Scheduled Task principal returned invalid data for ${taskName}`);
  }
  return {
    enabled: parsed.enabled,
    lastRunTime: parsed.lastRunTime,
    lastTaskResult: parsed.lastTaskResult,
    logonType: parsed.logonType,
    runLevel: parsed.runLevel,
    taskState: parsed.taskState,
  };
}

export function readRelatedProcessDiagnostics(needles: string[]): {
  error: string | null;
  ok: boolean;
  processes: WindowsProcessDiagnostic[];
  truncated: boolean;
} {
  const script = [
    "$ErrorActionPreference='Stop'",
    "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine,UserModeTime,KernelModeTime,ReadOperationCount,WriteOperationCount,OtherOperationCount,@{Name='CreationDate';Expression={if ($_.CreationDate) {$_.CreationDate.ToUniversalTime().ToString('o')}}} | ConvertTo-Json -Compress",
  ].join("; ");
  const result = spawnSync(
    getWindowsPowerShellExePath(),
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    { encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 5_000, windowsHide: true },
  );
  if (result.error) {
    return { error: result.error.message, ok: false, processes: [], truncated: false };
  }
  if (result.status !== 0) {
    return {
      error: result.stderr.trim() || `PowerShell exited ${result.status ?? "without status"}`,
      ok: false,
      processes: [],
      truncated: false,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout.trim() || "[]");
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
      ok: false,
      processes: [],
      truncated: false,
    };
  }
  const entries = (Array.isArray(parsed) ? parsed : [parsed]).filter(
    (entry): entry is WindowsProcessDiagnostic => typeof entry === "object" && entry !== null,
  );
  const normalizedNeedles = needles.map((needle) => needle.replaceAll("/", "\\").toLowerCase());
  const matching = entries.filter((entry) => {
    const commandLine = (entry.CommandLine ?? "").replaceAll("/", "\\").toLowerCase();
    return normalizedNeedles.some((needle) => commandLine.includes(needle));
  });
  const matchingPids = new Set(
    matching
      .map((entry) => entry.ProcessId)
      .filter((pid): pid is number => typeof pid === "number"),
  );
  // Anchors and console hosts need not carry fixture paths in argv. Expand only
  // descendants of matching processes; context parents must not admit unrelated siblings.
  let descendantsAdded: boolean;
  do {
    descendantsAdded = false;
    for (const entry of entries) {
      if (
        typeof entry.ProcessId === "number" &&
        typeof entry.ParentProcessId === "number" &&
        matchingPids.has(entry.ParentProcessId) &&
        !matchingPids.has(entry.ProcessId)
      ) {
        matchingPids.add(entry.ProcessId);
        descendantsAdded = true;
      }
    }
  } while (descendantsAdded);
  const parentPids = new Set(
    matching
      .map((entry) => entry.ParentProcessId)
      .filter((pid): pid is number => typeof pid === "number"),
  );
  const processes = entries.filter(
    (entry) =>
      matching.includes(entry) ||
      (typeof entry.ProcessId === "number" &&
        (matchingPids.has(entry.ProcessId) || parentPids.has(entry.ProcessId))),
  );
  return {
    error: null,
    ok: true,
    processes: processes.slice(0, DIAGNOSTIC_PROCESS_LIMIT),
    truncated: processes.length > DIAGNOSTIC_PROCESS_LIMIT,
  };
}

export function sanitizeDiagnosticText(
  value: string | null | undefined,
  replacements: Array<[string, string]>,
): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const variantPlaceholders = new Map<string, string>();
  for (const [privateValue, placeholder] of replacements) {
    if (privateValue) {
      for (const variant of new Set([
        privateValue,
        privateValue.replaceAll("/", "\\"),
        privateValue.replaceAll("\\", "/"),
      ])) {
        variantPlaceholders.set(variant.toLowerCase(), placeholder);
      }
    }
  }
  const pattern = Array.from(variantPlaceholders.keys())
    .toSorted((left, right) => right.length - left.length)
    .map((variant) => variant.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
    .join("|");
  const sanitized = pattern
    ? value.replace(new RegExp(pattern, "giu"), (match) => {
        return variantPlaceholders.get(match.toLowerCase()) ?? match;
      })
    : value;
  return sanitized.length <= DIAGNOSTIC_TEXT_LIMIT
    ? sanitized
    : `${sanitized.slice(0, DIAGNOSTIC_TEXT_LIMIT)}\n[truncated]`;
}

export function sanitizeTaskXml(
  value: string | null,
  replacements: Array<[string, string]>,
): string | null {
  const identityRedacted =
    value?.replace(
      /<(UserId|Author)>([\s\S]*?)<\/\1>/giu,
      (_match, tag: string) => `<${tag}><task-user></${tag}>`,
    ) ?? null;
  if (identityRedacted === null) {
    return null;
  }
  return identityRedacted
    .split(/(<[^>]+>)/gu)
    .map((segment) =>
      segment.startsWith("<") ? segment : (sanitizeDiagnosticText(segment, replacements) ?? ""),
    )
    .join("");
}

export function sanitizeVerboseQuery(
  value: string,
  replacements: Array<[string, string]>,
): string | null {
  return (
    sanitizeDiagnosticText(value, replacements)?.replace(
      /^(\s*(?:HostName|Run As User)\s*:\s*).*$/gimu,
      "$1<redacted>",
    ) ?? null
  );
}

export function resolveDiagnosticReplacements(params: {
  rootDir: string;
  stateDir: string;
}): Array<[string, string]> {
  const username = os.userInfo().username;
  const domain = process.env.USERDOMAIN?.trim();
  return [
    [os.userInfo().homedir, "<account-home>"],
    [params.rootDir, "<integration-root>"],
    [params.stateDir, "<state-dir>"],
    [domain && username ? `${domain}\\${username}` : "", "<task-user>"],
    [process.env.COMPUTERNAME?.trim() ?? "", "<host>"],
    [os.hostname(), "<host>"],
  ];
}

export function assertInteractiveLeastPrivilegeTask(params: {
  principal: ScheduledTaskPrincipal;
  taskXml: string;
}): void {
  expect(params.taskXml).toContain("<LogonType>InteractiveToken</LogonType>");
  expect(params.principal.logonType).toBe(TASK_LOGON_INTERACTIVE_TOKEN);
  expect(params.principal.runLevel).toBe(TASK_RUNLEVEL_LEAST_PRIVILEGE);
  const exportedRunLevel = params.taskXml.match(/<RunLevel>([^<]+)<\/RunLevel>/u)?.[1];
  // Task Scheduler may omit the default LeastPrivilege node when exporting XML.
  // If present, it must agree with the effective COM principal checked above.
  expect(exportedRunLevel === undefined || exportedRunLevel === "LeastPrivilege").toBe(true);
}

/** Wait for the service owner to report the expected native runtime and identity. */
export async function waitForRuntimeStatus(
  readRuntime: () => Promise<GatewayServiceRuntime>,
  expected: "running" | "stopped",
  expectedPid?: number,
): Promise<void> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  let lastStatus = "unknown";
  let lastDetail = "";
  let lastPid: number | undefined;
  while (Date.now() < deadline) {
    const runtime = await readRuntime();
    lastStatus = runtime.status ?? "unknown";
    lastDetail = runtime.detail ?? "";
    lastPid = runtime.pid;
    if (runtime.status === expected && (expectedPid === undefined || runtime.pid === expectedPid)) {
      return;
    }
    await sleep(WAIT_INTERVAL_MS);
  }
  throw new Error(
    `Timed out waiting for Scheduled Task status=${expected}${
      expectedPid === undefined ? "" : ` pid=${expectedPid}`
    }; observed ${lastStatus}${lastPid === undefined ? "" : ` pid=${lastPid}`}: ${lastDetail}`,
  );
}

/** Wait for Scheduler to record the completed native invocation and exit code. */
export async function waitForCompletedScheduledTaskRun(
  taskName: string,
  exitCode: number,
): Promise<ScheduledTaskPrincipal> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  let lastPrincipal: ScheduledTaskPrincipal | null = null;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      lastPrincipal = readTaskPrincipal(taskName);
      if (
        lastPrincipal.taskState === TASK_STATE_READY &&
        lastPrincipal.lastTaskResult === exitCode &&
        !Number.isNaN(Date.parse(lastPrincipal.lastRunTime)) &&
        Date.parse(lastPrincipal.lastRunTime) > 0
      ) {
        return lastPrincipal;
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(WAIT_INTERVAL_MS);
  }
  throw new Error(
    `Timed out waiting for Scheduled Task ${taskName} to finish with exit ${exitCode}; ${
      lastPrincipal
        ? `observed state=${lastPrincipal.taskState} result=${lastPrincipal.lastTaskResult}`
        : `last inspection failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`
    }`,
  );
}
