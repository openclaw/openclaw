import path from "node:path";
import { resolveConfigDir, resolveUserPath } from "../utils.js";
import { resolveBundledPluginsDir } from "./bundled-dir.js";

export type PluginSourceRoots = {
  stock?: string;
  global: string;
  workspace?: string;
};

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
