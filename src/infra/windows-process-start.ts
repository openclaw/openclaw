// Reads PID-reuse-safe Windows process start identities without workspace imports.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { resolveDiagnosticProcessEnv, resolveEnvironmentValue } from "./process-env.ts";

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_PROCESS_START_TIMEOUT_MS = 10_000;
const DEFAULT_WINDOWS_SYSTEM_ROOT = "C:\\Windows";
declare const SEALED_RUNTIME_BUILD: boolean;
let nativeProcessStartTime: ((pid: number) => number | null) | undefined;

function loadNativeProcessStartTime(): (pid: number) => number | null {
  const koffi: typeof import("koffi").default = createRequire(import.meta.url)("koffi");
  const kernel32 = koffi.load("kernel32.dll");
  const openProcess = kernel32.func(
    "void * __stdcall OpenProcess(uint32_t access, int32_t inheritHandle, uint32_t processId)",
  );
  const getProcessTimes = kernel32.func(
    "int32_t __stdcall GetProcessTimes(void *process, void *creation, void *exit, void *kernel, void *user)",
  );
  const closeHandle = kernel32.func("int32_t __stdcall CloseHandle(void *handle)");
  return (pid) => {
    const handle: bigint | null = openProcess(0x1000, 0, pid);
    if (handle === null) {
      return null;
    }
    try {
      const creation = Buffer.alloc(8);
      if (!getProcessTimes(handle, creation, Buffer.alloc(8), Buffer.alloc(8), Buffer.alloc(8))) {
        return null;
      }
      const ticks = creation.readBigUInt64LE();
      if (ticks === 0n) {
        return null;
      }
      // FILETIME exceeds Number's exact integer range; discard sub-millisecond ticks first.
      return Number(ticks / 10000n - 11644473600000n);
    } finally {
      closeHandle(handle);
    }
  };
}

function readNativeProcessStartTime(pid: number): number | null {
  // Sealed updater helpers must remain independent of the replaced installation's native modules.
  if (
    process.platform !== "win32" ||
    (typeof SEALED_RUNTIME_BUILD === "boolean" && SEALED_RUNTIME_BUILD)
  ) {
    return null;
  }
  try {
    nativeProcessStartTime ??= loadNativeProcessStartTime();
    return nativeProcessStartTime(pid);
  } catch {
    return null;
  }
}

function windowsSystemRoot(env: NodeJS.ProcessEnv): string {
  const configured =
    resolveEnvironmentValue(env, "SystemRoot", "win32") ??
    resolveEnvironmentValue(env, "WINDIR", "win32");
  if (!configured) {
    return DEFAULT_WINDOWS_SYSTEM_ROOT;
  }
  const normalized = path.win32.normalize(configured);
  return /^[A-Za-z]:\\/.test(normalized) && !normalized.startsWith("\\\\")
    ? normalized
    : DEFAULT_WINDOWS_SYSTEM_ROOT;
}

function windowsPowerShellPath(env: NodeJS.ProcessEnv): string {
  return path.win32.join(
    windowsSystemRoot(env),
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

function windowsWmicPath(env: NodeJS.ProcessEnv): string {
  return path.win32.join(windowsSystemRoot(env), "System32", "wbem", "wmic.exe");
}

export function decodeWindowsProcessOutput(output: Buffer | string): string {
  if (!Buffer.isBuffer(output)) {
    return output;
  }
  return output.length >= 2 && output[0] === 0xff && output[1] === 0xfe
    ? output.toString("utf16le")
    : output.toString("utf8");
}

function parseWindowsProcessStartTime(raw: Buffer | string): number | null {
  const lines = decodeWindowsProcessOutput(raw)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const value =
    lines
      .find((line) => line.toLowerCase().startsWith("creationdate="))
      ?.slice("creationdate=".length)
      .trim() ??
    lines.find((line) => line.toLowerCase() !== "creationdate") ??
    "";
  const parsedIso = Date.parse(value);
  if (Number.isFinite(parsedIso)) {
    return parsedIso;
  }
  const dmtf = value.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(\d{6})([+-])(\d{3})$/);
  if (!dmtf) {
    return null;
  }
  const [, year, month, day, hour, minute, second, microseconds, offsetSign, offset] = dmtf;
  const localTimeMs = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    Math.floor(Number(microseconds) / 1000),
  );
  const offsetMs = Number(offset) * 60_000 * (offsetSign === "+" ? 1 : -1);
  return localTimeMs - offsetMs;
}

/** Read a stable Windows process creation time for lock-owner identity checks. */
export function readWindowsProcessStartTimeSync(
  pid: number,
  timeoutMs = DEFAULT_PROCESS_START_TIMEOUT_MS,
  env: NodeJS.ProcessEnv = process.env,
): number | null {
  if (!Number.isInteger(pid) || pid <= 0 || pid > 0xffff_ffff) {
    return null;
  }
  // Preserve both former 5s attempts inside one deadline. Explicit callers
  // still keep their smaller end-to-end budget.
  const deadline = Date.now() + timeoutMs;
  const nativeStartTime = readNativeProcessStartTime(pid);
  if (nativeStartTime !== null) {
    return nativeStartTime;
  }
  const powershellBudgetMs = deadline - Date.now();
  if (powershellBudgetMs <= 0) {
    return null;
  }
  const powershell = spawnSync(
    windowsPowerShellPath(env),
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      // Read the kernel timestamp without CIM module discovery consuming the
      // caller's short ownership-query budget. Dispose the opened process handle.
      `$process = [System.Diagnostics.Process]::GetProcessById(${pid}); try { [Console]::Out.Write($process.StartTime.ToUniversalTime().ToString("o")) } finally { $process.Dispose() }`,
    ],
    {
      encoding: "utf8",
      env: resolveDiagnosticProcessEnv(env, "win32"),
      timeout: Math.min(powershellBudgetMs, DEFAULT_TIMEOUT_MS),
      windowsHide: true,
    },
  );
  if (!powershell.error && powershell.status === 0) {
    const startTime = parseWindowsProcessStartTime(powershell.stdout);
    if (startTime !== null) {
      return startTime;
    }
  }
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    return null;
  }
  const wmic = spawnSync(
    windowsWmicPath(env),
    ["process", "where", `ProcessId=${pid}`, "get", "CreationDate", "/value"],
    {
      env: resolveDiagnosticProcessEnv(env, "win32"),
      timeout: remainingMs,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  return !wmic.error && wmic.status === 0 ? parseWindowsProcessStartTime(wmic.stdout) : null;
}

/** Read one process snapshot; a reused parent PID must not extend the ancestry. */
export function readWindowsProcessAncestorsSync(
  pid: number,
  maxDepth: number,
  timeoutMs: number,
  env: NodeJS.ProcessEnv = process.env,
): { pids: number[]; complete: boolean } {
  try {
    const result = spawnSync(
      windowsPowerShellPath(env),
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        [
          "ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process",
          "-Property ProcessId,ParentProcessId,CreationDate -ErrorAction Stop | ForEach-Object {",
          "if ($null -ne $_.CreationDate) { [pscustomobject]@{ pid = $_.ProcessId; parentPid = $_.ParentProcessId;",
          "startedAt = $_.CreationDate.ToUniversalTime().Ticks.ToString() } } })",
        ].join(" "),
      ],
      {
        encoding: "utf8",
        env: resolveDiagnosticProcessEnv(env, "win32"),
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      },
    );
    if (result.error || result.status !== 0) {
      return { pids: [], complete: false };
    }
    const parsed: unknown = JSON.parse(result.stdout);
    if (!Array.isArray(parsed)) {
      return { pids: [], complete: false };
    }
    const rows: unknown[] = parsed;
    const processes = new Map<number, { parentPid: number; startedAt: bigint }>();
    for (const row of rows) {
      if (
        !row ||
        typeof row !== "object" ||
        !("pid" in row) ||
        typeof row.pid !== "number" ||
        !Number.isSafeInteger(row.pid) ||
        row.pid <= 0 ||
        !("parentPid" in row) ||
        typeof row.parentPid !== "number" ||
        !Number.isSafeInteger(row.parentPid) ||
        row.parentPid < 0 ||
        !("startedAt" in row) ||
        typeof row.startedAt !== "string" ||
        !/^[1-9]\d{0,18}$/.test(row.startedAt)
      ) {
        continue;
      }
      if (processes.has(row.pid)) {
        return { pids: [], complete: false };
      }
      processes.set(row.pid, { parentPid: row.parentPid, startedAt: BigInt(row.startedAt) });
    }
    const ancestors = new Set<number>();
    let current = processes.get(pid);
    for (let depth = 0; current && depth < maxDepth; depth++) {
      const parentPid = current.parentPid;
      const parent = processes.get(parentPid);
      // Keep native ticks: rounding to milliseconds can accept rapid PID reuse.
      if (
        !parent ||
        parentPid === pid ||
        ancestors.has(parentPid) ||
        parent.startedAt > current.startedAt
      ) {
        break;
      }
      ancestors.add(parentPid);
      current = parent;
    }
    return { pids: [...ancestors], complete: current?.parentPid === 0 };
  } catch {
    return { pids: [], complete: false };
  }
}
