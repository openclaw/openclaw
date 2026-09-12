// Resolves development source roots for local plugin installs.
import fs from "node:fs";
import path from "node:path";
import { resolveOpenClawPackageRootSync } from "../infra/openclaw-root.js";
import { isPathInside } from "../infra/path-guards.js";
import { resolveUserPath } from "../utils.js";
import { isPluginInPackageBundledRoots, isSourceCheckoutRoot } from "./bundled-dir.js";
import { pluginCacheExistsSync, pluginCacheRealpathSync } from "./plugin-cache-files.js";
import { getPluginCache } from "./plugin-cache.js";

/** Env var that points bundled-plugin lookup at an OpenClaw source checkout. */
const OPENCLAW_DEV_SOURCE_ROOT_ENV = "OPENCLAW_DEV_SOURCE_ROOT";

function readPackageName(packageJsonPath: string): string | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8")) as { name?: unknown };
    return typeof parsed.name === "string" ? parsed.name : null;
  } catch {
    return null;
  }
}

/** Resolves and validates the configured OpenClaw development source root. */
export function resolveOpenClawDevSourceRoot(env: NodeJS.ProcessEnv = process.env): string | null {
  const rawRoot = env[OPENCLAW_DEV_SOURCE_ROOT_ENV]?.trim();
  if (!rawRoot) {
    return null;
  }
  const resolvedRoot = resolveUserPath(rawRoot, env);
  const roots = getPluginCache().sdk.devSourceRoots;
  if (roots.has(resolvedRoot)) {
    return roots.get(resolvedRoot) ?? null;
  }
  const realRoot = pluginCacheRealpathSync(resolvedRoot);
  const valid =
    realRoot &&
    readPackageName(path.join(realRoot, "package.json")) === "openclaw" &&
    pluginCacheExistsSync(path.join(realRoot, "src")) &&
    pluginCacheExistsSync(path.join(realRoot, "extensions"));
  const result = valid ? realRoot : null;
  roots.set(resolvedRoot, result);
  return result;
}

/** Source builds own their bundled SDK consumers even without an explicit development selector. */
export function resolveBundledPluginSourceRoot(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const selected = resolveOpenClawDevSourceRoot(env);
  if (selected) {
    return selected;
  }
  const hostRoot = resolveOpenClawPackageRootSync({ moduleUrl: import.meta.url });
  return hostRoot && isSourceCheckoutRoot(hostRoot) ? hostRoot : null;
}

export function formatSourceBundledPluginNotice(pluginId: string): string {
  return `Kept bundled plugin "${pluginId}" from the OpenClaw source build; the registry artifact has no matching host SDK build identity. Matching version strings do not establish SDK compatibility.`;
}

/** Prioritizes already-bundled candidates; the selector itself never grants provenance. */
export function isBundledPluginInsideDevSourceRoot(params: {
  rootDir: string;
  env: NodeJS.ProcessEnv;
}): boolean {
  const devSourceRoot = resolveBundledPluginSourceRoot(params.env);
  if (!devSourceRoot) {
    return false;
  }
  if (
    !isPluginInPackageBundledRoots({
      packageRoot: devSourceRoot,
      rootDir: resolveUserPath(params.rootDir, params.env),
    })
  ) {
    return false;
  }
  if (resolveOpenClawDevSourceRoot(params.env)) {
    return true;
  }
  // Raw source can opt out of host builds; only compiled bundles gain automatic priority.
  const hostRoot = pluginCacheRealpathSync(devSourceRoot);
  const pluginRoot = pluginCacheRealpathSync(resolveUserPath(params.rootDir, params.env));
  return Boolean(
    hostRoot &&
    pluginRoot &&
    ["dist", "dist-runtime"].some((tree) =>
      isPathInside(path.join(hostRoot, tree, "extensions"), pluginRoot),
    ),
  );
}
