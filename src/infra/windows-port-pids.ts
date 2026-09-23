// Resolves Windows process identity and listening-port ownership.
import { spawnSync } from "node:child_process";
import { parseStrictPositiveInteger } from "@openclaw/normalization-core/number-coercion";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { splitArgsPreservingQuotes } from "../daemon/arg-split.js";
import { parseWindowsNetstatListeners } from "./ports-netstat.js";
import { resolveDiagnosticProcessEnv } from "./process-env.js";
import {
  getWindowsPowerShellExePath,
  getWindowsSystem32ExePath,
  getWindowsWmicExePath,
} from "./windows-install-roots.js";
import { decodeWindowsProcessOutput } from "./windows-process-start.js";

const DEFAULT_TIMEOUT_MS = 5_000;

export type WindowsListeningPidsResult =
  | { ok: true; pids: number[] }
  | { ok: false; permanent: boolean };

export type WindowsProcessArgsResult =
  | { ok: true; args: string[] | null }
  | { ok: false; permanent: boolean };

// ---------------------------------------------------------------------------
// Windows listening-PID discovery (PowerShell → netstat fallback)
// ---------------------------------------------------------------------------

function readListeningPidsViaPowerShell(port: number, timeoutMs: number): number[] | null {
  const ps = spawnSync(
    getWindowsPowerShellExePath(),
    [
      "-NoProfile",
      "-Command",
      `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess)`,
    ],
    {
      env: resolveDiagnosticProcessEnv(),
      encoding: "utf8",
      timeout: timeoutMs,
      windowsHide: true,
    },
  );
  if (ps.error || ps.status !== 0) {
    return null;
  }
  return ps.stdout.split(/\r?\n/).flatMap((line) => parseStrictPositiveInteger(line.trim()) ?? []);
}

function parseListeningPidsFromNetstat(stdout: string, port: number): number[] {
  return [...new Set(parseWindowsNetstatListeners(stdout, port).map((listener) => listener.pid))];
}

export function readWindowsListeningPidsOnPortSync(
  port: number,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): number[] {
  const result = readWindowsListeningPidsResultSync(port, timeoutMs);
  return result.ok ? result.pids : [];
}

export function readWindowsListeningPidsResultSync(
  port: number,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): WindowsListeningPidsResult {
  const powershellPids = readListeningPidsViaPowerShell(port, timeoutMs);
  if (powershellPids != null) {
    return { ok: true, pids: powershellPids };
  }
  const netstat = spawnSync(getWindowsSystem32ExePath("netstat.exe"), ["-ano"], {
    env: resolveDiagnosticProcessEnv(),
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
  });
  if (netstat.error) {
    const code = (netstat.error as NodeJS.ErrnoException).code;
    return { ok: false, permanent: code === "ENOENT" || code === "EACCES" || code === "EPERM" };
  }
  if (netstat.status !== 0) {
    return { ok: false, permanent: false };
  }
  return { ok: true, pids: parseListeningPidsFromNetstat(netstat.stdout, port) };
}

// ---------------------------------------------------------------------------
// Windows process identity reading (PowerShell → WMIC fallback)
// ---------------------------------------------------------------------------

function extractWindowsCommandLine(raw: Buffer | string): string | null {
  const lines = normalizeStringEntries(decodeWindowsProcessOutput(raw).split(/\r?\n/));
  for (const line of lines) {
    if (!normalizeLowercaseStringOrEmpty(line).startsWith("commandline=")) {
      continue;
    }
    const value = line.slice("commandline=".length).trim();
    return value || null;
  }
  return lines.find((line) => normalizeLowercaseStringOrEmpty(line) !== "commandline") ?? null;
}

export function readWindowsProcessArgsSync(
  pid: number,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  env: NodeJS.ProcessEnv = process.env,
  deadlineMs?: number,
): string[] | null {
  const result = readWindowsProcessArgsResultSync(pid, timeoutMs, env, deadlineMs);
  return result.ok ? result.args : null;
}

export function readWindowsProcessArgsResultSync(
  pid: number,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  env: NodeJS.ProcessEnv = process.env,
  deadlineMs?: number,
): WindowsProcessArgsResult {
  const remainingTimeoutMs = () =>
    deadlineMs === undefined
      ? timeoutMs
      : Math.min(timeoutMs, Math.max(0, Math.ceil(deadlineMs - performance.now())));
  if (remainingTimeoutMs() <= 0) {
    return { ok: false, permanent: false };
  }
  const powershellPath = getWindowsPowerShellExePath(env, deadlineMs);
  const powershellTimeoutMs = remainingTimeoutMs();
  if (powershellTimeoutMs <= 0) {
    return { ok: false, permanent: false };
  }
  const powershell = spawnSync(
    powershellPath,
    [
      "-NoProfile",
      "-Command",
      `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" | Select-Object -ExpandProperty CommandLine)`,
    ],
    {
      env: resolveDiagnosticProcessEnv(env),
      encoding: "utf8",
      timeout: powershellTimeoutMs,
      windowsHide: true,
    },
  );
  if (!powershell.error && powershell.status === 0) {
    const command = powershell.stdout.trim();
    // Native process argv has already passed through any batch-script escaping.
    return {
      ok: true,
      args: command
        ? splitArgsPreservingQuotes(command, { escapeMode: "backslash-quote-only" })
        : null,
    };
  }
  if (remainingTimeoutMs() <= 0) {
    return { ok: false, permanent: false };
  }
  const wmicPath = getWindowsWmicExePath(env, deadlineMs);
  const wmicTimeoutMs = remainingTimeoutMs();
  if (wmicTimeoutMs <= 0) {
    return { ok: false, permanent: false };
  }
  const wmic = spawnSync(
    wmicPath,
    ["process", "where", `ProcessId=${pid}`, "get", "CommandLine", "/value"],
    {
      env: resolveDiagnosticProcessEnv(env),
      timeout: wmicTimeoutMs,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  if (!wmic.error && wmic.status === 0) {
    const command = extractWindowsCommandLine(wmic.stdout);
    return {
      ok: true,
      args: command
        ? splitArgsPreservingQuotes(command, { escapeMode: "backslash-quote-only" })
        : null,
    };
  }
  const code = ((wmic.error ?? powershell.error) as NodeJS.ErrnoException | undefined)?.code;
  return { ok: false, permanent: code === "ENOENT" || code === "EACCES" || code === "EPERM" };
}
