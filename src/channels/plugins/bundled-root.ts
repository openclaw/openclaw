import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveOpenClawPackageRootSync } from "../../infra/openclaw-root.js";
import { resolveBundledPluginsDir } from "../../plugins/bundled-dir.js";

const OPENCLAW_PACKAGE_ROOT =
  resolveOpenClawPackageRootSync({
    argv1: process.argv[1],
    cwd: process.cwd(),
    moduleUrl: import.meta.url.startsWith("file:") ? import.meta.url : undefined,
  }) ??
  (import.meta.url.startsWith("file:")
    ? path.resolve(fileURLToPath(new URL("../../..", import.meta.url)))
    : process.cwd());

export function derivePackageRootFromBundledPluginsDir(pluginsDir: string): string {
  const resolvedDir = path.resolve(pluginsDir);
  if (path.basename(resolvedDir) !== "extensions") {
    return resolvedDir;
  }
  const parentDir = path.dirname(resolvedDir);
  const parentBase = path.basename(parentDir);
  if (parentBase === "dist" || parentBase === "dist-runtime") {
    return path.dirname(parentDir);
  }
  return parentDir;
}

export function resolveBundledChannelPackageRoot(env: NodeJS.ProcessEnv = process.env): string {
  const bundledPluginsDir = resolveBundledPluginsDir(env);
  if (bundledPluginsDir) {
    return derivePackageRootFromBundledPluginsDir(bundledPluginsDir);
  }
  return OPENCLAW_PACKAGE_ROOT;
}
