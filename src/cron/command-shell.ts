import { buildNodeShellCommand } from "../infra/node-shell.js";

/** Build the stored argv that runs a cron shell-string command on the Gateway host. */
export function buildCronCommandShellArgv(command: string, platform: string): string[] {
  // Windows has no sh by default; reuse the system.run cmd.exe flags. POSIX keeps the
  // login shell cron jobs have always used, so profile-provided PATH entries still apply.
  return platform === "win32" ? buildNodeShellCommand(command, platform) : ["sh", "-lc", command];
}
