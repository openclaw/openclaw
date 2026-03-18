import fs from "node:fs";
import path from "node:path";
import process from "node:process";

export const WINDOWS_CMD_SHIM_COMMANDS = ["npm", "npx", "pnpm", "yarn", "codex"] as const;
const DEFAULT_WINDOWS_PATHEXT = [".com", ".exe", ".bat", ".cmd"] as const;
const WINDOWS_UNSAFE_CMD_CHARS_RE = /[&|<>^%\r\n]/;

function parseWindowsPathExt(pathExt: string | undefined): string[] {
  const parsed = String(pathExt ?? "")
    .split(";")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
    .map((value) => (value.startsWith(".") ? value : `.${value}`));
  return parsed.length > 0 ? parsed : [...DEFAULT_WINDOWS_PATHEXT];
}

function findWindowsCommandMatch(params: {
  command: string;
  pathEnv?: string;
  pathExt?: string;
  fileExists?: (candidate: string) => boolean;
}): string | undefined {
  const fileExists = params.fileExists ?? fs.existsSync;
  const pathExts = parseWindowsPathExt(params.pathExt ?? process.env.PATHEXT);
  const isExplicitPath =
    path.win32.isAbsolute(params.command) || /[\\/]/.test(params.command);
  const candidateBases = isExplicitPath
    ? [params.command]
    : String(params.pathEnv ?? process.env.PATH ?? "")
        .split(";")
        .map((entry) => entry.trim().replace(/^"(.*)"$/, "$1"))
        .filter(Boolean)
        .map((entry) => path.win32.join(entry, params.command));

  for (const base of candidateBases) {
    for (const ext of pathExts) {
      const candidate = `${base}${ext}`;
      if (fileExists(candidate)) {
        return candidate;
      }
    }
  }

  return undefined;
}

export function isWindowsBatchCommand(
  resolvedCommand: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== "win32") {
    return false;
  }
  const ext = path.win32.extname(resolvedCommand).toLowerCase();
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

export function buildCmdExeCommandLine(resolvedCommand: string, args: string[]): string {
  return [escapeForCmdExe(resolvedCommand), ...args.map(escapeForCmdExe)].join(" ");
}

export function resolveWindowsCommandShim(params: {
  command: string;
  cmdCommands: readonly string[];
  platform?: NodeJS.Platform;
  pathEnv?: string;
  pathExt?: string;
  fileExists?: (candidate: string) => boolean;
}): string {
  const platform = params.platform ?? process.platform;
  if (platform !== "win32") {
    return params.command;
  }
  const basename = path.win32.basename(params.command).toLowerCase();
  if (path.win32.extname(basename)) {
    return params.command;
  }
  if (params.cmdCommands.includes(basename)) {
    const resolved = findWindowsCommandMatch({
      command: params.command,
      pathEnv: params.pathEnv,
      pathExt: params.pathExt,
      fileExists: params.fileExists,
    });
    if (resolved) {
      return resolved;
    }
    return `${params.command}.cmd`;
  }
  return params.command;
}
