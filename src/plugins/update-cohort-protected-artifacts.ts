import path from "node:path";
import { normalizeWindowsPathForComparison } from "../infra/path-guards.js";
import {
  resolveInstalledPluginIndexStateDatabaseOptions,
  type InstalledPluginIndexStoreOptions,
} from "./installed-plugin-index-store-path.js";
import { resolveRetainedManagedNpmInstallPackageInfo } from "./managed-npm-retention.js";
import { safeRealpathSync } from "./path-safety.js";

export type PluginCohortProtectedArtifacts = {
  includesPackageDir(packageDir: string): boolean;
  includesNpmRoot(npmRoot: string): boolean;
};

function comparisonPath(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === "win32" ? normalizeWindowsPathForComparison(resolved) : resolved;
}

/** Pending cohort preimages exclude repair writes; these facts grant no mutation authority. */
export async function loadPluginCohortProtectedArtifacts(
  options: InstalledPluginIndexStoreOptions = {},
): Promise<PluginCohortProtectedArtifacts> {
  // Auditing links must not load the update mutation graph or inspect recovery storage.
  const { inspectPluginCohortRecoveriesAsync } =
    await import("../infra/update-run-recovery-store.js");
  const pairs = await inspectPluginCohortRecoveriesAsync(
    resolveInstalledPluginIndexStateDatabaseOptions(options),
  );
  const packageDirs = new Set<string>();
  const npmRoots = new Set<string>();
  for (const { cohort } of pairs) {
    if (cohort.disposition === "commit") {
      continue;
    }
    for (const artifact of cohort.priorArtifacts) {
      if (artifact.identity === null) {
        continue;
      }
      for (const packageDir of [artifact.packageDir, artifact.identity.realPath]) {
        packageDirs.add(comparisonPath(packageDir));
        const info = resolveRetainedManagedNpmInstallPackageInfo(packageDir);
        if (info) {
          npmRoots.add(comparisonPath(info.projectRoot));
        }
      }
    }
  }
  const includes = (paths: ReadonlySet<string>, filePath: string): boolean => {
    if (paths.size === 0) {
      return false;
    }
    if (paths.has(comparisonPath(filePath))) {
      return true;
    }
    const realPath = safeRealpathSync(filePath);
    return realPath ? paths.has(comparisonPath(realPath)) : false;
  };
  return {
    includesPackageDir: (packageDir) => includes(packageDirs, packageDir),
    includesNpmRoot: (npmRoot) => includes(npmRoots, npmRoot),
  };
}
