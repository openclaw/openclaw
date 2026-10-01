import type { ConfigWriteOptions } from "../../../config/io.js";
import { resolveConfigIncludeWriteBoundary } from "../../../config/mutate.js";
import { cloneConfigWithResolutionFacts } from "../../../config/resolution-facts.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../../../config/types.openclaw.js";
import type { InstalledPluginIdRecovery } from "./installed-plugin-id-recovery.js";

/** Split only a root roster repair followed by one include-owned plugin recovery. */
export function prepareCanonicalRosterBeforePluginInclude(params: {
  snapshot: ConfigFileSnapshot;
  nextConfig: OpenClawConfig;
  persistCanonicalAgentRoster?: boolean;
  installedPluginIdRecovery?: InstalledPluginIdRecovery;
  explicitSetPaths?: ConfigWriteOptions["explicitSetPaths"];
}): OpenClawConfig | undefined {
  if (!params.persistCanonicalAgentRoster || !params.installedPluginIdRecovery?.size) {
    return undefined;
  }
  const includeCandidate = cloneConfigWithResolutionFacts(params.nextConfig);
  includeCandidate.agents = params.snapshot.sourceConfig.agents;
  const boundary = resolveConfigIncludeWriteBoundary({
    snapshot: params.snapshot,
    nextConfig: includeCandidate,
    explicitSetPaths: params.explicitSetPaths?.filter(([key]) => key !== "agents"),
  });
  if (!boundary || boundary.boundaryPath[0] !== "plugins") {
    return undefined;
  }
  const rosterCandidate = cloneConfigWithResolutionFacts(params.snapshot.sourceConfig);
  rosterCandidate.agents = params.nextConfig.agents;
  return rosterCandidate;
}

/** Preview the same physical-owner sequence that the guarded Doctor writer uses. */
export function canWriteDoctorInclude(
  snapshot: ConfigFileSnapshot,
  nextConfig: OpenClawConfig,
  options: Pick<ConfigWriteOptions, "persistCanonicalAgentRoster" | "explicitSetPaths">,
  installedPluginIdRecovery: InstalledPluginIdRecovery | undefined,
): boolean {
  return Boolean(
    resolveConfigIncludeWriteBoundary({ snapshot, nextConfig, ...options }) ||
    prepareCanonicalRosterBeforePluginInclude({
      snapshot,
      nextConfig,
      ...options,
      installedPluginIdRecovery,
    }),
  );
}
