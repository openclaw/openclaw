// Native identity inspection shared by Gateway lock admission and observation.
import { execFileSync } from "node:child_process";
import fsSync from "node:fs";
import { getFileLockProcessStartTime } from "../shared/pid-alive.js";
import { parseProcCmdline } from "./gateway-process-argv.js";
import { resolveDiagnosticProcessEnv } from "./process-env.js";
import { readWindowsProcessArgsSync } from "./windows-port-pids.js";

function readLinuxCmdline(pid: number): string[] | null {
  try {
    const raw = fsSync.readFileSync(`/proc/${pid}/cmdline`, "utf8");
    return parseProcCmdline(raw);
  } catch {
    return null;
  }
}

function readWindowsCmdline(pid: number, timeoutMs: number, deadlineMs?: number): string[] | null {
  return readWindowsProcessArgsSync(pid, timeoutMs, process.env, deadlineMs);
}

/**
 * Read the command line of a macOS/BSD process via `ps`.
 *
 * `ps -o command=` outputs an unquoted flat string, so the naive whitespace
 * split will misparse paths containing spaces. This is acceptable because
 * standard macOS install paths do not contain spaces, and when the split
 * does fail the caller falls back to "alive" (conservative).
 */
function readDarwinCmdline(pid: number, timeoutMs: number): string[] | null {
  try {
    const raw = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      env: resolveDiagnosticProcessEnv(),
      encoding: "utf8",
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const line = raw.trim();
    if (!line) {
      return null;
    }
    return line.split(/\s+/).filter(Boolean);
  } catch {
    return null;
  }
}

export function readGatewayLockProcessStartTime(
  pid: number,
  platform: NodeJS.Platform,
  timeoutMs: number,
): number | null {
  if (platform !== process.platform) {
    return null;
  }
  return getFileLockProcessStartTime(pid, process.env, timeoutMs);
}

export function readGatewayLockProcessCmdline(
  pid: number,
  platform: NodeJS.Platform,
  timeoutMs: number,
  deadlineMs?: number,
): string[] | null {
  if (platform === "linux") {
    return readLinuxCmdline(pid);
  }
  if (platform === "win32") {
    return readWindowsCmdline(pid, timeoutMs, deadlineMs);
  }
  if (platform === "darwin") {
    return readDarwinCmdline(pid, timeoutMs);
  }
  return null;
}
