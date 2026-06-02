import path from "node:path";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { resolveConfigDir, resolveUserPath } from "../utils.js";
import { resolveBundledPluginsDir } from "./bundled-dir.js";

/** Canonical plugin root directories checked by discovery and source display. */
export type PluginSourceRoots = {
  /** Bundled plugin root when bundled plugins are available. */
  stock?: string;
  /** User-global plugin install root under the OpenClaw config directory. */
  global: string;
  /** Workspace-local plugin install root when a workspace directory is active. */
  workspace?: string;
};

/** Inputs that define plugin registry/cache identity for one workspace/environment. */
export type PluginCacheInputs = {
  roots: PluginSourceRoots;
  loadPaths: string[];
};

/** Resolves stock, global, and workspace plugin roots from env-aware config paths. */
export function resolvePluginSourceRoots(params: {
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): PluginSourceRoots {
  const env = params.env ?? process.env;
  const workspaceRoot = params.workspaceDir ? resolveUserPath(params.workspaceDir, env) : undefined;
  const stock = resolveBundledPluginsDir(env);
  const global = path.join(resolveConfigDir(env), "extensions");
  const workspace = workspaceRoot ? path.join(workspaceRoot, ".openclaw", "extensions") : undefined;
  return { stock, global, workspace };
}

/** Resolves env-aware plugin root and load-path inputs for registry reuse. */
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
  const loadPaths = normalizeStringEntries(
    (params.loadPaths ?? []).filter((entry): entry is string => typeof entry === "string"),
  ).map((entry) => resolveUserPath(entry, env));
  return { roots, loadPaths };
}
