import path from "node:path";
import { resolveConfigDir, shortenHomeInString } from "../utils.js";
import { resolveBundledPluginsDir } from "./bundled-dir.js";
import type { PluginRecord } from "./registry.js";

export type PluginSourceRoots = {
  stock?: string;
  global?: string;
  workspace?: string;
};

function tryRelative(root: string, filePath: string): string | null {
  const rel = path.relative(root, filePath);
  if (!rel || rel === ".") {
    return null;
  }
  if (rel === "..") {
    return null;
  }
  if (rel.startsWith(`..${path.sep}`) || rel.startsWith("../") || rel.startsWith("..\\")) {
    return null;
  }
  if (path.isAbsolute(rel)) {
    return null;
  }
  // Normalize to forward slashes for display (path.relative uses backslashes on Windows)
  return rel.replaceAll("\\", "/");
}

export function resolvePluginSourceRoots(params: { workspaceDir?: string }): PluginSourceRoots {
  const stock = resolveBundledPluginsDir();
  const global = path.join(resolveConfigDir(), "extensions");
  const workspace = params.workspaceDir
    ? path.join(params.workspaceDir, ".openclaw", "extensions")
    : undefined;
  return { stock, global, workspace };
}

export function formatPluginSourceForTable(
  plugin: Pick<PluginRecord, "source" | "origin">,
  roots: PluginSourceRoots,
): { value: string; rootKey?: keyof PluginSourceRoots } {
  const raw = plugin.source;

  if (plugin.origin === "bundled" && roots.stock) {
    const rel = tryRelative(roots.stock, raw);
    if (rel) {
      return { value: `stock:${rel}`, rootKey: "stock" };
    }
  }
  if (plugin.origin === "workspace" && roots.workspace) {
    const rel = tryRelative(roots.workspace, raw);
    if (rel) {
      return { value: `workspace:${rel}`, rootKey: "workspace" };
    }
  }
  if (plugin.origin === "global" && roots.global) {
    const rel = tryRelative(roots.global, raw);
    if (rel) {
      return { value: `global:${rel}`, rootKey: "global" };
    }
  }

  // Keep this stable/pasteable; only ~-shorten.
  return { value: shortenHomeInString(raw) };
}
