import os from "node:os";
import path from "node:path";
import { resolveConfigDir, resolveUserPath } from "../utils.js";
import { resolveBundledPluginsDir } from "./bundled-dir.js";

export type PluginSourceRoots = {
  system: string;
  stock?: string;
  global: string;
  workspace?: string;
};

export type PluginCacheInputs = {
  roots: PluginSourceRoots;
  loadPaths: string[];
};

let systemPluginsDirOverrideForTest: string | undefined;

export function setSystemPluginsDirOverrideForTest(dir: string | undefined): void {
  systemPluginsDirOverrideForTest = dir;
}

/**
 * Resolve the machine-wide system plugin directory.
 *
 * Platform default:
 *   - Windows: %ProgramData%\OpenClaw\plugins
 *   - Linux/Mac: /etc/openclaw/plugins
 */
export function resolveSystemPluginsDir(env: NodeJS.ProcessEnv = process.env): string {
  if (systemPluginsDirOverrideForTest) {
    return systemPluginsDirOverrideForTest;
  }
  return os.platform() === "win32"
    ? path.join(env.PROGRAMDATA || "C:\\ProgramData", "OpenClaw", "plugins")
    : "/etc/openclaw/plugins";
}

export function resolvePluginSourceRoots(params: {
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): PluginSourceRoots {
  const env = params.env ?? process.env;
  const workspaceRoot = params.workspaceDir ? resolveUserPath(params.workspaceDir, env) : undefined;
  const system = resolveSystemPluginsDir(env);
  const stock = resolveBundledPluginsDir(env);
  const global = path.join(resolveConfigDir(env), "extensions");
  const workspace = workspaceRoot ? path.join(workspaceRoot, ".openclaw", "extensions") : undefined;
  return { system, stock, global, workspace };
}

// Shared env-aware key inputs for plugin loader registry reuse.
export function resolvePluginCacheInputs(params: {
  workspaceDir?: string;
  loadPaths?: string[];
  env?: NodeJS.ProcessEnv;
}): PluginCacheInputs {
  const env = params.env ?? process.env;
  const roots = resolvePluginSourceRoots({
    workspaceDir: params.workspaceDir,
    env,
  });
  // Preserve caller order because load-path precedence follows input order.
  const loadPaths = (params.loadPaths ?? [])
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => resolveUserPath(entry, env));
  return { roots, loadPaths };
}
