// Windows command helpers resolve executable and shell invocation details.
import path from "node:path";
import process from "node:process";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { getWindowsInstallRoots } from "../infra/windows-install-roots.js";

const WINDOWS_UNSAFE_CMD_CHARS_RE = /[&|<>^%\r\n]/;

export type WindowsBatchInvocation = {
  args: string[];
  command: string;
  windowsVerbatimArguments: true;
};

/**
 * Resolve commands that Windows exposes through .cmd shims.
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

export function isWindowsBatchCommand(params: {
  command: string;
  platform?: NodeJS.Platform;
}): boolean {
  if ((params.platform ?? process.platform) !== "win32") {
    return false;
  }
  const ext = normalizeLowercaseStringOrEmpty(path.extname(params.command));
  return ext === ".cmd" || ext === ".bat";
}

function escapeForCmdExe(arg: string): string {
  if (WINDOWS_UNSAFE_CMD_CHARS_RE.test(arg)) {
    throw new Error(
      `Unsafe Windows cmd.exe argument detected: ${JSON.stringify(arg)}. ` +
        "Pass an explicit shell-wrapper argv at the call site instead.",
    );
  }
  if (!arg.includes(" ") && !arg.includes('"')) {
    return arg;
  }
  return `"${arg.replace(/"/g, '""')}"`;
}

function buildCmdExeCommandLine(command: string, args: readonly string[]): string {
  return [escapeForCmdExe(command), ...args.map(escapeForCmdExe)].join(" ");
}

export function resolveTrustedWindowsCmdExe(
  params: {
    env?: Record<string, string | undefined>;
    platform?: NodeJS.Platform;
  } = {},
): string {
  if ((params.platform ?? process.platform) !== "win32") {
    return "cmd.exe";
  }
  return path.win32.join(getWindowsInstallRoots(params.env).systemRoot, "System32", "cmd.exe");
}

export function buildWindowsBatchInvocation(params: {
  args: readonly string[];
  command: string;
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
}): WindowsBatchInvocation | null {
  if (!isWindowsBatchCommand({ command: params.command, platform: params.platform })) {
    return null;
  }
  return {
    command: resolveTrustedWindowsCmdExe({ env: params.env, platform: params.platform }),
    args: ["/d", "/s", "/c", buildCmdExeCommandLine(params.command, params.args)],
    windowsVerbatimArguments: true,
  };
}
