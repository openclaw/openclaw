import path from "node:path";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { resolveUserPath } from "../utils.js";
import { isPluginNpmManagedPath, isPluginNpmProjectDir } from "./install-paths.js";
import { resolveRetainedManagedNpmInstallPackageInfo } from "./managed-npm-retention.js";
import { listManagedPluginNpmRootsSync } from "./npm-project-roots.js";

/** Selects active managed projects without discovering unrelated generations. */
export function listManagedPluginNpmRootsForInstallRecords(params: {
  npmRoot: string;
  installRecords: Record<string, PluginInstallRecord> | null;
  env?: NodeJS.ProcessEnv;
}): string[] {
  if (params.installRecords === null) {
    process.emitWarning(
      "Plugin install records could not be read; inspecting all managed npm roots for host-link repair.",
      { code: "OPENCLAW_PLUGIN_NPM_ROOTS_FALLBACK" },
    );
    return listManagedPluginNpmRootsSync(params.npmRoot);
  }
  const npmRoot = path.resolve(params.npmRoot);
  const roots = new Set<string>();
  for (const record of Object.values(params.installRecords)) {
    if (record.source !== "npm" || !record.installPath) {
      continue;
    }
    const packageDir = resolveUserPath(record.installPath, params.env);
    const info = resolveRetainedManagedNpmInstallPackageInfo(packageDir);
    if (
      info &&
      ((path.relative(npmRoot, info.projectRoot) === "" &&
        isPluginNpmManagedPath({ managedPath: packageDir, npmDir: npmRoot })) ||
        isPluginNpmProjectDir({
          packageName: info.packageName,
          projectDir: info.projectRoot,
          npmDir: npmRoot,
        }))
    ) {
      roots.add(info.projectRoot);
    }
  }
  return [...roots].toSorted((left, right) => left.localeCompare(right));
}
