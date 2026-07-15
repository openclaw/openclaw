// Resolves how the TUI launches the local `openclaw models auth login` flow
// (and the Codex CLI binary) across packaged, source-tree, and Windows setups.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tryProcessCwd } from "../infra/safe-cwd.js";
import { getWindowsSystem32ExePath } from "../infra/windows-install-roots.js";
import {
  buildWindowsCmdExeCommandLine,
  isWindowsBatchCommand,
  resolveTrustedWindowsCmdExe,
} from "../process/windows-command.js";

export const OPENCLAW_CLI_WRAPPER_PATH = fileURLToPath(
  new URL("../../openclaw.mjs", import.meta.url),
);
const OPENCLAW_RUN_NODE_SCRIPT_PATH = fileURLToPath(
  new URL("../../scripts/run-node.mjs", import.meta.url),
);
const OPENCLAW_DIST_ENTRY_JS_PATH = fileURLToPath(new URL("../../dist/entry.js", import.meta.url));
const OPENCLAW_DIST_ENTRY_MJS_PATH = fileURLToPath(
  new URL("../../dist/entry.mjs", import.meta.url),
);

/** Resolve the absolute path to the `codex` CLI binary, or `null` if not installed. */
export function resolveCodexCliBin(): string | null {
  try {
    const lookupCmd =
      process.platform === "win32" ? getWindowsSystem32ExePath("where.exe") : "which";
    // `where` on Windows can return multiple lines; take the first match.
    const raw = execFileSync(lookupCmd, ["codex"], { encoding: "utf8" }).trim();
    return raw.split(/\r?\n/)[0] || null;
  } catch {
    return null;
  }
}

export function resolveLocalAuthCliInvocation(params?: {
  execPath?: string;
  wrapperPath?: string;
  runNodePath?: string;
  hasDistEntry?: boolean;
  hasRunNodeScript?: boolean;
}): { command: string; args: string[] } {
  const hasDistEntry =
    params?.hasDistEntry ??
    (existsSync(OPENCLAW_DIST_ENTRY_JS_PATH) || existsSync(OPENCLAW_DIST_ENTRY_MJS_PATH));
  const hasRunNodeScript = params?.hasRunNodeScript ?? existsSync(OPENCLAW_RUN_NODE_SCRIPT_PATH);
  const command = params?.execPath ?? process.execPath;
  const wrapperPath = params?.wrapperPath ?? OPENCLAW_CLI_WRAPPER_PATH;
  const runNodePath = params?.runNodePath ?? OPENCLAW_RUN_NODE_SCRIPT_PATH;

  // Prefer the packaged wrapper when build output exists, but keep source-tree
  // auth working in unbuilt checkouts that only have scripts/run-node.mjs.
  return hasDistEntry || !hasRunNodeScript
    ? { command, args: [wrapperPath, "models", "auth", "login"] }
    : { command, args: [runNodePath, "models", "auth", "login"] };
}

export function resolveLocalAuthSpawnInvocation(params: {
  command: string;
  args: string[];
  platform?: NodeJS.Platform;
}): {
  args: string[];
  command: string;
  options: { windowsHide?: true; windowsVerbatimArguments?: true };
} {
  const platform = params.platform ?? process.platform;
  if (!isWindowsBatchCommand(params.command.trim(), platform)) {
    return { command: params.command, args: params.args, options: {} };
  }
  return {
    command: resolveTrustedWindowsCmdExe(platform),
    args: ["/d", "/s", "/c", buildWindowsCmdExeCommandLine(params.command, params.args)],
    options: { windowsHide: true, windowsVerbatimArguments: true },
  };
}

export function resolveLocalAuthSpawnCwd(params: { args: string[]; defaultCwd?: string }): string {
  const defaultCwd =
    params.defaultCwd ?? tryProcessCwd() ?? path.dirname(OPENCLAW_CLI_WRAPPER_PATH);
  const entryArg = params.args[0]?.trim();
  if (!entryArg) {
    return defaultCwd;
  }
  const entryBase = path.basename(entryArg).toLowerCase();
  if (entryBase === "openclaw.mjs") {
    return path.dirname(entryArg);
  }
  if (entryBase === "run-node.mjs") {
    return path.dirname(path.dirname(entryArg));
  }
  return defaultCwd;
}
