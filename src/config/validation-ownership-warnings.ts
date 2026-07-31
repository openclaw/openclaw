import { listChannelIdsForOwnershipMigration } from "../plugins/channel-presence-policy.js";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import { collectAgentOwnershipWarnings } from "./agent-ownership-warnings.js";
import { listLegacyOwnershipWarnings } from "./legacy.default-agent-owner.js";
import type { ConfigValidationIssue, OpenClawConfig } from "./types.js";

/** Computes ownership warnings from the latest resolved plugin registry. */
export function collectCurrentAgentOwnershipWarnings(params: {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  manifestRecords?: readonly PluginManifestRecord[];
}): ConfigValidationIssue[] {
  if (listAgentEntriesWithSource(params.config).length <= 1) {
    return [];
  }
  const ambientChannelIds = listChannelIdsForOwnershipMigration({
    config: params.config,
    env: params.env,
    ...(params.manifestRecords ? { manifestRecords: params.manifestRecords } : {}),
  });
  return collectAgentOwnershipWarnings(params.config, ambientChannelIds);
}

/** Replaces ownership warnings computed before legacy role materialization. */
export function refreshMaterializedAgentOwnershipWarnings(params: {
  warnings: readonly ConfigValidationIssue[];
  before: OpenClawConfig;
  after: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  manifestRecords?: readonly PluginManifestRecord[];
}): ConfigValidationIssue[] {
  const ambientChannelIds = listChannelIdsForOwnershipMigration({
    config: params.after,
    env: params.env,
    ...(params.manifestRecords ? { manifestRecords: params.manifestRecords } : {}),
  });
  const staleOwnershipWarnings = new Set(
    collectAgentOwnershipWarnings(params.before, ambientChannelIds).map(
      (warning) => `${warning.path}\0${warning.message}`,
    ),
  );
  const warnings = [
    ...params.warnings.filter(
      (warning) => !staleOwnershipWarnings.has(`${warning.path}\0${warning.message}`),
    ),
    ...collectAgentOwnershipWarnings(params.after, ambientChannelIds),
    ...listLegacyOwnershipWarnings(params.after),
  ];
  const seen = new Set<string>();
  return warnings.filter((warning) => {
    const key = `${warning.path}\0${warning.message}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
import { listAgentEntriesWithSource } from "../agents/agent-scope.js";
