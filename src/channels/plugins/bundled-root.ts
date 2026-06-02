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

export type BundledChannelRootScope = {
  /** Package root used to resolve generated bundled metadata and runtime files. */
  packageRoot: string;
  /** Stable partition key for bundled module and metadata caches. */
  cacheKey: string;
  /** Optional override tree that replaces the package's bundled extensions dir. */
  pluginsDir?: string;
};

function derivePackageRootFromExtensionsDir(extensionsDir: string): string {
  const parentDir = path.dirname(extensionsDir);
  const parentBase = path.basename(parentDir);
  if (parentBase === "dist" || parentBase === "dist-runtime") {
    return path.dirname(parentDir);
  }
  return parentDir;
}

/**
 * Resolves the active bundled channel root. Packaged builds use the OpenClaw
 * package root; tests and override flows can point at a replacement plugin tree.
 */
export function resolveBundledChannelRootScope(
  env: NodeJS.ProcessEnv = process.env,
): BundledChannelRootScope {
  const bundledPluginsDir = resolveBundledPluginsDir(env);
  if (!bundledPluginsDir) {
    return {
      packageRoot: OPENCLAW_PACKAGE_ROOT,
      cacheKey: OPENCLAW_PACKAGE_ROOT,
    };
  }
  const resolvedPluginsDir = path.resolve(bundledPluginsDir);
  return {
    // Overrides can point either at an `extensions/` tree or directly at a
    // generated plugin root; keep the package root aligned with that shape so
    // generated metadata and runtime imports share one boundary.
    packageRoot:
      path.basename(resolvedPluginsDir) === "extensions"
        ? derivePackageRootFromExtensionsDir(resolvedPluginsDir)
        : resolvedPluginsDir,
    cacheKey: resolvedPluginsDir,
    pluginsDir: resolvedPluginsDir,
  };
}
