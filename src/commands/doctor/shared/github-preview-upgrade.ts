import type { NormalizedPluginsConfig } from "../../../plugins/config-state.js";
import { loadBundledPluginPublicArtifactModuleFromCandidatesSync } from "../../../plugins/public-surface-loader.js";

/** Optional bundled diagnostics must not prevent Doctor from repairing minimal installs. */
export function collectGitHubUpgradeWarnings(policy: NormalizedPluginsConfig): string[] {
  const artifact = loadBundledPluginPublicArtifactModuleFromCandidatesSync<{
    collectGitHubUpgradeWarnings: (policy: NormalizedPluginsConfig) => string[];
  }>({
    dirName: "github",
    artifactCandidates: ["upgrade-api.js"],
  });
  return artifact?.collectGitHubUpgradeWarnings(policy) ?? [];
}
