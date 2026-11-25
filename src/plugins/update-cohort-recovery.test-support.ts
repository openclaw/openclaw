import fs from "node:fs";
import path from "node:path";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import type { OpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  resolvePluginNpmGenerationProjectDir,
  resolvePluginNpmProjectDir,
} from "./install-paths.js";
import { writeManagedNpmPlugin } from "./test-helpers/managed-npm-plugin.js";
import { readPluginCohortPublishedArtifactIdentity } from "./update-cohort-artifacts.js";

export const fence = { assertCurrent() {} };
export const config = { plugins: { enabled: false } };
export const packageName = "@example/cohort-fixture";

export function generation(state: OpenClawTestState, version: string, pluginId = "fixture") {
  writeManagedNpmPlugin({ stateDir: state.stateDir, packageName, pluginId, version });
  const npmDir = state.statePath("npm");
  const npmRoot = resolvePluginNpmGenerationProjectDir({
    npmDir,
    packageName,
    generationKey: version,
  });
  fs.renameSync(resolvePluginNpmProjectDir({ npmDir, packageName }), npmRoot);
  const packageDir = path.join(npmRoot, "node_modules", ...packageName.split("/"));
  const record: PluginInstallRecord = {
    source: "npm",
    spec: `${packageName}@${version}`,
    version,
    installPath: packageDir,
  };
  return {
    npmRoot,
    packageDir,
    record,
    identity: readPluginCohortPublishedArtifactIdentity(packageDir),
  };
}
