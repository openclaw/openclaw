import { spawnSync } from "node:child_process";
import { parseCmdScriptCommandLine } from "../daemon/cmd-argv.js";

const DEFAULT_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// Windows listening-PID discovery (PowerShell → netstat fallback)
// ---------------------------------------------------------------------------

function readListeningPidsViaPowerShell(port: number, timeoutMs: number): number[] | null {
  const ps = spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess)`,
    ],
    {
      encoding: "utf8",
      timeout: timeoutMs,
      windowsHide: true,
    },
  );
  if (ps.error || ps.status !== 0) {
    return null;
  }
  return ps.stdout
    .split(/\r?\n/)
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((pid) => Number.isFinite(pid) && pid > 0);
}

function readListeningPidsViaNetstat(port: number, timeoutMs: number): number[] {
  const netstat = spawnSync("netstat", ["-ano", "-p", "tcp"], {
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
  });
  if (netstat.error || netstat.status !== 0) {
    return [];
  }
  const pids = new Set<number>();
  for (const line of netstat.stdout.split(/\r?\n/)) {
    const match = line.match(/^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i);
    if (!match) {
      continue;
    }
    const parsedPort = Number.parseInt(match[2] ?? "", 10);
    const pid = Number.parseInt(match[3] ?? "", 10);
    if (parsedPort === port && Number.isFinite(pid) && pid > 0) {
      pids.add(pid);
    }
  }
  return [...pids];
}

export function readWindowsListeningPidsOnPortSync(
  port: number,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): number[] {
  return readListeningPidsViaPowerShell(port, timeoutMs) ?? readListeningPidsViaNetstat(port, timeoutMs);
}

// ---------------------------------------------------------------------------
// Windows process-args reading (PowerShell → WMIC fallback)
// ---------------------------------------------------------------------------

function extractWindowsCommandLine(raw: string): string | null {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines) {
    if (!line.toLowerCase().startsWith("commandline=")) {
      continue;
    }
    const value = line.slice("commandline=".length).trim();
    return value || null;
  }
  return lines.find((line) => line.toLowerCase() !== "commandline") ?? null;
}

function readProcessArgsViaPowerShell(pid: number, timeoutMs: number): string[] | null {
  const ps = spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" | Select-Object -ExpandProperty CommandLine)`,
    ],
    {
      encoding: "utf8",
      timeout: timeoutMs,
      windowsHide: true,
    },
  );
  if (ps.error || ps.status !== 0) {
    return null;
  }
  const command = ps.stdout.trim();
  return command ? parseCmdScriptCommandLine(command) : null;
}

function readProcessArgsViaWmic(pid: number, timeoutMs: number): string[] | null {
  const wmic = spawnSync(
    "wmic",
    ["process", "where", `ProcessId=${pid}`, "get", "CommandLine", "/value"],
    {
      encoding: "utf8",
      timeout: timeoutMs,
      windowsHide: true,
    },
  );
  if (wmic.error || wmic.status !== 0) {
    return null;
  }
  const command = extractWindowsCommandLine(wmic.stdout);
  return command ? parseCmdScriptCommandLine(command) : null;
}

export function readWindowsProcessArgsSync(
  pid: number,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): string[] | null {
  return readProcessArgsViaPowerShell(pid, timeoutMs) ?? readProcessArgsViaWmic(pid, timeoutMs);
}
