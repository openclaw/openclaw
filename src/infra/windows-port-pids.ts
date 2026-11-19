// Resolves Windows process identity and listening-port ownership.
import { spawnSync } from "node:child_process";
import { parseStrictPositiveInteger } from "@openclaw/normalization-core/number-coercion";
import { parseWindowsNativeCommandLine } from "../process/windows-command-line.js";
import { parseWindowsNetstatListeners } from "./ports-netstat.js";
import type { PortUsageStatus } from "./ports-types.js";
import { resolveDiagnosticProcessEnv } from "./process-env.js";
import { assertAppContainerSpawnSupported } from "./windows-appcontainer-spawn.js";
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

// Windows listening-PID discovery (PowerShell → netstat fallback)

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

export function readWindowsListeningPidsOnPortSync(port: number): number[] {
  const result = readWindowsListeningPidsResultSync(port);
  return result.ok ? result.pids : [];
}

export function readWindowsListeningPidsResultSync(
  port: number,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): WindowsListeningPidsResult {
  assertAppContainerSpawnSupported();
  const powershellPids = readListeningPidsViaPowerShell(port, timeoutMs);
  if (powershellPids != null && powershellPids.length > 0) {
    return { ok: true, pids: powershellPids };
  }
  // A successful empty PowerShell census is not proof the port is free; the
  // listener can be missing from CIM. Ask netstat before reporting empty.
  const netstat = spawnSync(getWindowsSystem32ExePath("netstat.exe"), ["-ano"], {
    env: resolveDiagnosticProcessEnv(),
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
  });
  if (netstat.error) {
    if (powershellPids != null) {
      return { ok: true, pids: powershellPids };
    }
    const code = (netstat.error as NodeJS.ErrnoException).code;
    return { ok: false, permanent: code === "ENOENT" || code === "EACCES" || code === "EPERM" };
  }
  if (netstat.status !== 0) {
    if (powershellPids != null) {
      return { ok: true, pids: powershellPids };
    }
    return { ok: false, permanent: false };
  }
  const netstatPids = parseListeningPidsFromNetstat(netstat.stdout, port);
  return {
    ok: true,
    pids: powershellPids != null ? [...new Set([...powershellPids, ...netstatPids])] : netstatPids,
  };
}

/** Read-only bounded listener observation, without PID enrichment or a second budget. */
export function readWindowsPortUsageSync(port: number, timeoutMs: number): PortUsageStatus {
  if (
    process.platform !== "win32" ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535 ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs < 1
  ) {
    return "unknown";
  }
  assertAppContainerSpawnSupported();
  const result = spawnSync(
    getWindowsPowerShellExePath(),
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$ErrorActionPreference = 'Stop'; " +
        `@(Get-NetTCPConnection -ErrorAction Stop | Where-Object { $_.LocalPort -eq ${port} -and $_.State -eq 'Listen' }).Count`,
    ],
    {
      env: resolveDiagnosticProcessEnv(),
      encoding: "utf8",
      timeout: Math.min(Math.floor(timeoutMs), DEFAULT_TIMEOUT_MS),
      windowsHide: true,
    },
  );
  if (result.error || result.status !== 0) {
    return "unknown";
  }
  const count = result.stdout.trim();
  return /^\d+$/.test(count) ? (Number(count) === 0 ? "free" : "busy") : "unknown";
}

// Windows process identity reading (PowerShell → WMIC fallback)

function extractWindowsCommandLine(raw: Buffer | string): string | null {
  const output = decodeWindowsProcessOutput(raw).trim();
  const command = (
    /^CommandLine=(.*)$/is.exec(output)?.[1] ?? output.replace(/^CommandLine\r?\n/i, "")
  ).trim();
  return command && command.toLowerCase() !== "commandline" ? command : null;
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
  assertAppContainerSpawnSupported();
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
      [
        `$command = (Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" | Select-Object -ExpandProperty CommandLine)`,
        "$bytes = [Text.Encoding]::UTF8.GetBytes([string]$command)",
        // Write pipe bytes directly; changing OutputEncoding can require a console.
        "[Console]::OpenStandardOutput().Write($bytes, 0, $bytes.Length)",
      ].join("; "),
    ],
    {
      env: resolveDiagnosticProcessEnv(env),
      encoding: "utf8",
      timeout: powershellTimeoutMs,
      windowsHide: true,
    },
  );
  if (!powershell.error && powershell.status === 0) {
    const command = powershell.stdout;
    // Native process argv has already passed through any batch-script escaping.
    const args = command ? parseWindowsNativeCommandLine(command) : null;
    return command && args === null ? { ok: false, permanent: false } : { ok: true, args };
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
    const args = command ? parseWindowsNativeCommandLine(command) : null;
    return command && args === null ? { ok: false, permanent: false } : { ok: true, args };
  }
  const code = ((wmic.error ?? powershell.error) as NodeJS.ErrnoException | undefined)?.code;
  return { ok: false, permanent: code === "ENOENT" || code === "EACCES" || code === "EPERM" };
}
