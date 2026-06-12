// Windows command helpers resolve executable and shell invocation details.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

/**
 * Resolve package-manager commands that Windows exposes through .cmd shims.
 * Explicit extensions are preserved so callers can pass already-resolved tools.
 *
 * Behavior:
 * - Non-Windows: returns the command unchanged.
 * - Already has an extension (.cmd/.bat/.com/.exe): returned as-is.
 * - Listed in `cmdCommands` (e.g. npm/pnpm/yarn/npx): appended with `.cmd`.
 * - Otherwise: walks PATH for an existing `.cmd`/`.bat`/`.com` matching the
 *   basename and returns the first absolute hit. Falls back to the original
 *   (un-resolved) command if nothing is found, so the caller's spawn layer
 *   can decide what to do (e.g. raise a clear ENOENT).
 */
export function resolveWindowsCommandShim(params: {
  command: string;
  cmdCommands: readonly string[];
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
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
  return resolveViaPathWalk(params.command, params.env ?? process.env) ?? params.command;
}

const WINDOWS_PATH_EXTENSIONS = [".cmd", ".bat", ".com"] as const;

function resolveViaPathWalk(command: string, env: NodeJS.ProcessEnv): string | null {
  if (path.isAbsolute(command)) {
    return null;
  }
  const pathValue = env.PATH ?? env.Path ?? env.path ?? "";
  if (!pathValue) {
    return null;
  }
  const dirs = pathValue.split(path.delimiter);
  for (const dir of dirs) {
    if (!dir) {
      continue;
    }
    for (const ext of WINDOWS_PATH_EXTENSIONS) {
      const candidate = path.join(dir, command + ext);
      try {
        if (fs.existsSync(candidate)) {
          return candidate;
        }
      } catch {
        // Ignore stat errors and keep walking.
      }
    }
  }
  return null;
}
