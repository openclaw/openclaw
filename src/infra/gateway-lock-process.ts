// Native identity inspection shared by Gateway lock admission and observation.
import fsSync from "node:fs";
import { readDarwinProcessCommand } from "../process/supervisor/darwin-process-command.js";
import { getFileLockProcessStartTime } from "../shared/pid-alive.js";
import { parseProcCmdline } from "./gateway-process-argv.js";
import { readWindowsProcessArgsSync } from "./windows-port-pids.js";

export function readGatewayLockProcessStartTime(
  pid: number,
  platform: NodeJS.Platform,
  timeoutMs: number,
): number | null {
  return platform === process.platform
    ? getFileLockProcessStartTime(pid, process.env, timeoutMs)
    : null;
}

export function readGatewayLockProcessCmdline(
  pid: number,
  platform: NodeJS.Platform,
  timeoutMs: number,
  deadlineMs?: number,
  env: NodeJS.ProcessEnv = process.env,
): string[] | null {
  try {
    if (platform === "linux") {
      return parseProcCmdline(fsSync.readFileSync(`/proc/${pid}/cmdline`, "utf8"));
    }
    if (platform === "win32") {
      return readWindowsProcessArgsSync(pid, timeoutMs, env, deadlineMs);
    }
    if (platform === "darwin") {
      const command = readDarwinProcessCommand(pid);
      return command && "argv" in command ? command.argv : null;
    }
  } catch {
    // An inaccessible process has no observed command identity.
  }
  return null;
}
