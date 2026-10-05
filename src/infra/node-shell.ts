// Builds platform shell argv for Node-driven command execution.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { formatExecCommand } from "./system-run-command.js";
import { resolveWindowsDirectCommandArgv } from "./windows-direct-command.js";

// Node shell command construction keeps platform shell flags centralized for
// system.run and related command execution paths.
/** Build argv for running a command through the platform default shell. */
export function buildNodeShellCommand(command: string, platform?: string | null) {
  const normalized = normalizeLowercaseStringOrEmpty((platform ?? "").trim());
  if (normalized.startsWith("win")) {
    return ["cmd.exe", "/d", "/s", "/c", command];
  }
  if (normalized === "darwin" || normalized.startsWith("macos")) {
    // The Mac node binds static allowlisted commands through non-login sh.
    // A login shell can execute unapproved startup files before the payload.
    return ["/bin/sh", "-c", command];
  }
  return ["/bin/sh", "-lc", command];
}

export function buildNodeCommandInvocation(
  command: string,
  platform?: string | null,
): { argv: string[]; rawCommand: string } {
  const isWindows = normalizeLowercaseStringOrEmpty((platform ?? "").trim()).startsWith("win");
  const directArgv = isWindows ? resolveWindowsDirectCommandArgv(command) : null;
  return directArgv
    ? { argv: directArgv, rawCommand: formatExecCommand(directArgv) }
    : { argv: buildNodeShellCommand(command, platform), rawCommand: command };
}
