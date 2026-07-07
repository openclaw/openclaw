// Windows command helpers resolve executable and shell invocation details.
import path from "node:path";
import process from "node:process";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { getWindowsCmdExePath } from "../infra/windows-install-roots.js";

const WINDOWS_UNSAFE_CMD_CHARS_RE = /[&|<>%\r\n]/;

export function isWindowsBatchCommand(
  resolvedCommand: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== "win32") {
    return false;
  }
  const ext = normalizeLowercaseStringOrEmpty(path.extname(resolvedCommand));
  return ext === ".cmd" || ext === ".bat";
}

function escapeForWindowsCmdExe(arg: string): string {
  if (WINDOWS_UNSAFE_CMD_CHARS_RE.test(arg)) {
    throw new Error(
      `Unsafe Windows cmd.exe argument detected: ${JSON.stringify(arg)}. ` +
        "Pass an explicit shell-wrapper argv at the call site instead.",
    );
  }
  const escaped = arg.replace(/\^/g, "^^");
  if (!escaped.includes(" ") && !escaped.includes('"')) {
    return escaped;
  }
  return `"${escaped.replace(/"/g, '""')}"`;
}

export function buildWindowsCmdExeCommandLine(command: string, args: readonly string[]): string {
  const escapedCommand = escapeForWindowsCmdExe(command);
  const commandLine = [escapedCommand, ...args.map(escapeForWindowsCmdExe)].join(" ");
  return escapedCommand.startsWith('"') ? `"${commandLine}"` : commandLine;
}

export function resolveTrustedWindowsCmdExe(platform: NodeJS.Platform = process.platform): string {
  if (platform !== "win32") {
    return "cmd.exe";
  }
  return getWindowsCmdExePath();
}

/**
 * Resolve package-manager commands that Windows exposes through .cmd shims.
 * Explicit extensions are preserved so callers can pass already-resolved tools.
 */
export function resolveWindowsCommandShim(params: {
  command: string;
  cmdCommands: readonly string[];
  platform?: NodeJS.Platform;
}): string {
  if ((params.platform ?? process.platform) !== "win32") {
    return params.command;
  }
  const basename = normalizeLowercaseStringOrEmpty(path.basename(params.command));
  if (path.extname(basename)) {
    return params.command;
  }
  if (params.cmdCommands.includes(basename)) {
    return `${params.command}.cmd`;
  }
  return params.command;
}
