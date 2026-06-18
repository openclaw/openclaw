// Windows command helpers resolve executable and shell invocation details.
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

/**
 * Resolve package-manager commands that Windows exposes through .cmd shims.
 * Explicit extensions are preserved so callers can pass already-resolved tools.
 * Unadorned commands not in `cmdCommands` are resolved by walking the system
 * PATHEXT environment variable against PATH directories.
 */
export function resolveWindowsCommandShim(params: {
  command: string;
  cmdCommands: readonly string[];
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  pathExists?: (candidate: string) => boolean;
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
  // Walk system PATHEXT for unadorned commands (claude, codex, gemini, etc.)
  // so the supervisor can spawn them without callers having to register each
  // one in the per-process cmdCommands allowlist.
  const env = params.env ?? process.env;
  const pathExists = params.pathExists ?? existsSync;
  const pathext = (env.PATHEXT ?? ".EXE;.BAT;.CMD")
    .split(";")
    .map((ext) => ext.trim().toLowerCase())
    .filter(Boolean);
  const pathDirs = (env.PATH ?? "")
    .split(path.delimiter)
    .map((dir) => dir.trim())
    .filter(Boolean);
  for (const dir of pathDirs) {
    for (const ext of pathext) {
      const candidate = path.join(dir, `${basename}${ext}`);
      if (pathExists(candidate)) {
        return candidate;
      }
    }
  }
  return params.command;
}
