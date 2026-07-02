// Windows command helpers resolve executable and shell invocation details.
import path from "node:path";
import process from "node:process";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { getWindowsCmdExePath } from "../infra/windows-install-roots.js";

const WINDOWS_UNSAFE_CMD_CHARS_RE = /[\r\n]/u;

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

/**
 * Escape a single argument for a cmd.exe command line.
 *
 * Carriage returns and newlines can never safely appear in a cmd.exe command
 * line and are rejected.  Arguments that contain spaces or double quotes are
 * wrapped in double quotes with internal quotes escaped as `""`; inside double
 * quotes `&|<>^` are already literal, so no caret escaping is needed.
 * Arguments without spaces are left unquoted and `&|<>^%` are caret-escaped so
 * cmd.exe treats them literally.
 */
function escapeForWindowsCmdExe(arg: string): string {
  if (WINDOWS_UNSAFE_CMD_CHARS_RE.test(arg)) {
    throw new Error(
      `Unsafe Windows cmd.exe argument detected: ${JSON.stringify(arg)}. ` +
        "Newline characters are not supported in cmd.exe command lines.",
    );
  }

  const needsQuoting = arg.includes(" ") || arg.includes('"');

  if (needsQuoting) {
    // Inside double quotes, &|<>^ are literal in cmd.exe — no caret escaping
    // needed. Only escape embedded double quotes as "" and wrap in quotes.
    return `"${arg.replaceAll('"', '""')}"`;
  }

  // Outside quotes: caret-escape metacharacters so cmd.exe treats them
  // literally.  ^ escapes first so subsequent replacements don't create new ^
  // sequences, % is escaped with ^% to suppress variable expansion.
  return arg
    .replaceAll("^", "^^")
    .replaceAll("&", "^&")
    .replaceAll("|", "^|")
    .replaceAll("<", "^<")
    .replaceAll(">", "^>")
    .replaceAll("%", "^%");
}

export function buildWindowsCmdExeCommandLine(command: string, args: readonly string[]): string {
  const escapedCommand = escapeForWindowsCmdExe(command);
  const escapedArgs = args.map((arg) => escapeForWindowsCmdExe(arg));
  const commandLine = [escapedCommand, ...escapedArgs].join(" ");
  if (escapedCommand.startsWith('"')) {
    return `"${commandLine}"`;
  }
  return commandLine;
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
