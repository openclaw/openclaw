// Windows command helpers resolve executable and shell invocation details.
import path from "node:path";
import process from "node:process";
import { resolveExecutablePath } from "../infra/executable-path.js";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

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

const BATCH_EXTS = new Set([".cmd", ".bat"]);

function isWindowsBatchPath(resolved: string): boolean {
  return BATCH_EXTS.has(path.extname(resolved).toLowerCase());
}

function resolveTrustedCmdExe(): string {
  const sysroot = process.env["SystemRoot"] ?? process.env["SYSTEMROOT"] ?? "C:\\Windows";
  return path.join(sysroot, "System32", "cmd.exe");
}

// Mirrors escapeForCmdExe in src/process/exec.ts:
// - Rejects characters that cmd.exe interprets as operators (&, |, <, >, ^, %, CR, LF)
// - Quotes tokens containing spaces or double-quotes
// SECURITY: same injection-rejection strategy exec.ts uses for its shell-adjacent paths.
function escapeCmdToken(token: string): string {
  if (/[&|<>^%\r\n]/.test(token)) {
    throw new Error(
      `Supervisor: unsafe character in argv token for Windows batch dispatch: ${JSON.stringify(token)}`,
    );
  }
  if (/[ "]/.test(token)) {
    return '"' + token.replace(/"/g, '""') + '"';
  }
  return token;
}

/**
 * Resolves a Windows CLI shim command (e.g., "claude", "npm") to its absolute path via
 * PATHEXT-aware lookup, then wraps batch files (.cmd/.bat) in a trusted cmd.exe invocation.
 *
 * Returns the replacement argv to pass to spawnWithFallback (shell: false), or undefined if
 * no Windows batch handling is needed (not on Windows, or command resolved to a .exe).
 *
 * SECURITY: never passes `shell: true`. Routes batch files through cmd.exe /d /s /c with
 * argument escaping that rejects shell metacharacters — same contract as src/process/exec.ts.
 */
export function resolveWindowsBatchSpawnArgv(
  command: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): string[] | undefined {
  if (process.platform !== "win32") return undefined;

  const resolved = resolveExecutablePath(command, { env: env ?? process.env });
  if (!resolved) return undefined;
  if (!isWindowsBatchPath(resolved)) return undefined;

  const cmdExe = resolveTrustedCmdExe();
  const allTokens = [resolved, ...args];
  const cmdLine = allTokens.map(escapeCmdToken).join(" ");
  return [cmdExe, "/d", "/s", "/c", cmdLine];
}
