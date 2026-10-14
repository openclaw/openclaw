/** Resolves the Doctor artifact shared by loading, index hashing, and freshness. */
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { OpenClawPackageManifest } from "./manifest.js";
import { pluginCacheRealpathSync } from "./plugin-cache-files.js";
import { getPluginCacheRoot } from "./plugin-cache.js";
import type { PluginOrigin } from "./plugin-origin.types.js";
import {
  resolvePluginRuntimeExecutionArtifact,
  resolvePreferredBundledRootArtifact,
} from "./plugin-runtime-artifact-selection.js";
import { resolvePluginRootArtifactPath } from "./root-artifact-path.js";

const CONTRACT_API_EXTENSIONS = [".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"] as const;
const CURRENT_MODULE_PATH = fileURLToPath(import.meta.url);
const RUNNING_FROM_BUILT_ARTIFACT =
  CURRENT_MODULE_PATH.includes(`${path.sep}dist${path.sep}`) ||
  CURRENT_MODULE_PATH.includes(`${path.sep}dist-runtime${path.sep}`);
const ORDERED_EXTENSIONS = RUNNING_FROM_BUILT_ARTIFACT
  ? CONTRACT_API_EXTENSIONS
  : ([...CONTRACT_API_EXTENSIONS.slice(3), ...CONTRACT_API_EXTENSIONS.slice(0, 3)] as const);
const ARTIFACT_CANDIDATES = ["doctor-contract-api", "contract-api"].map((basename) => {
  const rootPaths = ORDERED_EXTENSIONS.map((extension) => `${basename}${extension}`);
  return {
    rootPaths,
    paths: rootPaths.flatMap((filename) => [filename, path.join("dist", filename)]),
  };
});

type DoctorArtifactSelection = {
  rootDir: string;
  origin: PluginOrigin;
  sourcePreferred?: boolean;
  packageManifest?: OpenClawPackageManifest;
};

export function resolvePluginDoctorContractArtifact(
  params: DoctorArtifactSelection,
): { modulePath: string; boundaryRoot: string } | null {
  const artifacts = getPluginCacheRoot(params.rootDir).artifacts;
  const key = JSON.stringify([
    "doctor-contract",
    RUNNING_FROM_BUILT_ARTIFACT,
    params.origin,
    params.sourcePreferred === true,
    params.packageManifest?.build?.bundledDist,
  ]);
  const cached = artifacts.get(key);
  if (cached !== undefined) {
    return cached;
  }
  for (const { rootPaths, paths } of ARTIFACT_CANDIDATES) {
    const modulePath = resolvePluginRootArtifactPath(params.rootDir, paths);
    if (!modulePath) {
      continue;
    }
    let artifact = { modulePath, boundaryRoot: params.rootDir };
    if (RUNNING_FROM_BUILT_ARTIFACT && params.origin === "bundled" && !params.sourcePreferred) {
      // Preserve Doctor's package-local extension order. Source-external plugins
      // instead anchor the canonical build at an available root source file.
      const source =
        params.packageManifest?.build?.bundledDist === false
          ? resolvePluginRootArtifactPath(params.rootDir, rootPaths)
          : rootPaths.includes(path.relative(params.rootDir, modulePath))
            ? modulePath
            : null;
      if (source) {
        const selected = resolvePluginRuntimeExecutionArtifact(
          resolvePreferredBundledRootArtifact({
            rootDir: params.rootDir,
            source,
            packageManifest: params.packageManifest,
          }),
        );
        artifact = { modulePath: selected.source, boundaryRoot: selected.rootDir };
      }
    }
    const resolved = {
      modulePath: pluginCacheRealpathSync(artifact.modulePath) ?? artifact.modulePath,
      boundaryRoot: pluginCacheRealpathSync(artifact.boundaryRoot) ?? artifact.boundaryRoot,
    };
    artifacts.set(key, resolved);
    return resolved;
  }
  artifacts.set(key, null);
  return null;
}
