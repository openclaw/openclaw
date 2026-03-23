import { spawnSync } from "node:child_process";
import fsSync from "node:fs";
import { parseCmdScriptCommandLine } from "../daemon/cmd-argv.js";
import { isGatewayArgv, parseProcCmdline } from "./gateway-process-argv.js";
import { findGatewayPidsOnPortSync as findUnixGatewayPidsOnPortSync } from "./restart-stale-pids.js";

const WINDOWS_GATEWAY_DISCOVERY_TIMEOUT_MS = 5_000;

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

function readWindowsProcessArgsViaPowerShell(pid: number): string[] | null {
  const ps = spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" | Select-Object -ExpandProperty CommandLine)`,
    ],
    {
      encoding: "utf8",
      timeout: WINDOWS_GATEWAY_DISCOVERY_TIMEOUT_MS,
      windowsHide: true,
    },
  );
  if (ps.error || ps.status !== 0) {
    return null;
  }
  const command = ps.stdout.trim();
  return command ? parseCmdScriptCommandLine(command) : null;
}

function readWindowsProcessArgsViaWmic(pid: number): string[] | null {
  const wmic = spawnSync(
    "wmic",
    ["process", "where", `ProcessId=${pid}`, "get", "CommandLine", "/value"],
    {
      encoding: "utf8",
      timeout: WINDOWS_GATEWAY_DISCOVERY_TIMEOUT_MS,
      windowsHide: true,
    },
  );
  if (wmic.error || wmic.status !== 0) {
    return null;
  }
  const command = extractWindowsCommandLine(wmic.stdout);
  return command ? parseCmdScriptCommandLine(command) : null;
}

function readWindowsListeningPidsViaPowerShell(port: number): number[] | null {
  const ps = spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess)`,
    ],
    {
      encoding: "utf8",
      timeout: WINDOWS_GATEWAY_DISCOVERY_TIMEOUT_MS,
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

function readWindowsListeningPidsViaNetstat(port: number): number[] {
  const netstat = spawnSync("netstat", ["-ano", "-p", "tcp"], {
    encoding: "utf8",
    timeout: WINDOWS_GATEWAY_DISCOVERY_TIMEOUT_MS,
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

function readWindowsListeningPidsOnPortSync(port: number): number[] {
  return readWindowsListeningPidsViaPowerShell(port) ?? readWindowsListeningPidsViaNetstat(port);
}

export function readGatewayProcessArgsSync(pid: number): string[] | null {
  if (process.platform === "linux") {
    try {
      return parseProcCmdline(fsSync.readFileSync(`/proc/${pid}/cmdline`, "utf8"));
    } catch {
      return null;
    }
  }
  if (process.platform === "darwin") {
    const ps = spawnSync("ps", ["-o", "command=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 1000,
    });
    if (ps.error || ps.status !== 0) {
      return null;
    }
    const command = ps.stdout.trim();
    return command ? command.split(/\s+/) : null;
  }
  if (process.platform === "win32") {
    return readWindowsProcessArgsViaPowerShell(pid) ?? readWindowsProcessArgsViaWmic(pid);
  }
  return null;
}

export function signalVerifiedGatewayPidSync(pid: number, signal: "SIGTERM" | "SIGUSR1"): void {
  const args = readGatewayProcessArgsSync(pid);
  if (!args || !isGatewayArgv(args, { allowGatewayBinary: true })) {
    throw new Error(`refusing to signal non-gateway process pid ${pid}`);
  }
  process.kill(pid, signal);
}

export function findVerifiedGatewayListenerPidsOnPortSync(port: number): number[] {
  const rawPids =
    process.platform === "win32"
      ? readWindowsListeningPidsOnPortSync(port)
      : findUnixGatewayPidsOnPortSync(port);

  return Array.from(new Set(rawPids))
    .filter((pid): pid is number => Number.isFinite(pid) && pid > 0 && pid !== process.pid)
    .filter((pid) => {
      const args = readGatewayProcessArgsSync(pid);
      return args != null && isGatewayArgv(args, { allowGatewayBinary: true });
    });
}

export function formatGatewayPidList(pids: number[]): string {
  return pids.join(", ");
}
