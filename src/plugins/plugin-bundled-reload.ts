import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isPathInside } from "../infra/path-guards.js";
import { readRuntimeDependencyOwnership } from "../infra/runtime-dependency-ownership.js";

/** Serializable ownership facts shared by capture workers and recovered generations. */
export type BundledPluginReloadSource = {
  hostRoot: string;
  ownedPaths: readonly string[];
};

/** Capture the plugin tree and plugin-only build chunks, never the host's shared graph. */
export function resolveBundledPluginReloadSource(rootDir: string): BundledPluginReloadSource {
  const parent = path.dirname(rootDir);
  if (path.basename(parent) !== "extensions") {
    return { hostRoot: rootDir, ownedPaths: ["."] };
  }
  const tree = path.dirname(parent);
  const built = ["dist", "dist-runtime"].includes(path.basename(tree));
  const hostRoot = built ? path.dirname(tree) : tree;
  const id = path.basename(rootDir);
  const ownedPaths = built
    ? [path.join("dist", "extensions", id), path.join("dist-runtime", "extensions", id)]
    : [path.relative(hostRoot, rootDir)];
  // Build metadata excludes chunks reachable from core/SDK entries. Shared plugin-only
  // chunks may be captured independently; host-owned chunks must keep process identity.
  if (built) {
    const ownership = readRuntimeDependencyOwnership(hostRoot);
    if (!ownership) {
      throw new Error(
        "Bundled plugin reload requires build ownership metadata; rebuild OpenClaw first.",
      );
    }
    for (const [chunk, owners] of Object.entries(ownership.chunks)) {
      const relative = path.join("dist", chunk);
      if (
        owners.extensions.includes(id) &&
        isPathInside(hostRoot, path.resolve(hostRoot, relative))
      ) {
        ownedPaths.push(relative);
      }
    }
  }
  return {
    hostRoot,
    ownedPaths: ownedPaths.filter((entry) => fs.existsSync(path.join(hostRoot, entry))),
  };
}

/** Select source roots for a fresh capture or a recovered bundled generation. */
export function bundledPluginCaptureInputs(
  rootDir: string,
  source: string,
  policy: BundledPluginReloadSource | undefined,
  recovering: boolean,
  standalone: boolean | undefined,
): [string, string | string[] | undefined] {
  const root = policy && !recovering ? policy.hostRoot : rootDir;
  const entries = policy
    ? policy.ownedPaths.map((relative) => path.join(root, relative))
    : standalone
      ? source
      : undefined;
  return [root, entries];
}

/** Resolve host-relative imports to canonical modules, including during source recovery. */
export function resolveBundledSharedModule(
  policy: BundledPluginReloadSource | undefined,
  sourceRoot: string,
  importer: string,
  specifier: string,
): string | undefined {
  if (
    !policy ||
    !(specifier.startsWith(".") || specifier.startsWith("file:") || path.isAbsolute(specifier))
  ) {
    return undefined;
  }
  const target = specifier.startsWith("file:")
    ? fileURLToPath(specifier)
    : path.resolve(path.dirname(importer), specifier);
  if (!isPathInside(sourceRoot, target)) {
    return undefined;
  }
  const relative = path.relative(sourceRoot, target);
  if (
    relative.split(path.sep).includes("node_modules") ||
    policy.ownedPaths.some((owned) => isPathInside(path.resolve(sourceRoot, owned), target))
  ) {
    return undefined;
  }
  return path.resolve(policy.hostRoot, relative);
}
