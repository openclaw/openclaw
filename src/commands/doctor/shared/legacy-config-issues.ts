// Doctor legacy config issue finder that combines core, channel, and plugin rules.
import { collectChannelLegacyConfigRules } from "../../../channels/plugins/legacy-config.js";
import { isConfigReadFailure } from "../../../config/io.invalid-config.js";
import { findLegacyConfigIssues } from "../../../config/legacy.js";
import type { LegacyConfigRule } from "../../../config/legacy.shared.js";
import type {
  ConfigFileSnapshot,
  LegacyConfigIssue,
  OpenClawConfig,
} from "../../../config/types.js";
import { withPluginMetadataSnapshotScope } from "../../../plugins/current-plugin-metadata-snapshot.js";
import {
  collectDoctorConfigRepairPluginIds,
  listPluginDoctorLegacyConfigRules,
} from "../../../plugins/doctor-contract-registry.js";
import { resolvePluginMetadataSnapshotAsync } from "../../../plugins/plugin-metadata-snapshot.js";
import type { PluginMetadataSnapshot } from "../../../plugins/plugin-metadata-snapshot.types.js";
import { listDoctorConfiguredChannelIds } from "./configured-channel-ids.js";
import { findLegacySystemAgentOwnerIssue } from "./legacy-config-migrations.runtime.system-agent.js";

function collectPluginLegacyConfigRules(
  raw: unknown,
  touchedPaths?: ReadonlyArray<ReadonlyArray<string>>,
  env?: NodeJS.ProcessEnv,
): LegacyConfigRule[] {
  const channelIds = new Set(listDoctorConfiguredChannelIds(raw, { configEntryPolicy: "raw" }));
  const pluginIds = collectDoctorConfigRepairPluginIds(raw, touchedPaths, env).filter(
    (pluginId) => !channelIds.has(pluginId),
  );
  if (pluginIds.length === 0) {
    return [];
  }
  return listPluginDoctorLegacyConfigRules({ config: raw as OpenClawConfig, pluginIds, env });
}

/** Find legacy config issues using core rules plus relevant channel/plugin doctor contracts. */
export function findDoctorLegacyConfigIssues(
  raw: unknown,
  sourceRaw?: unknown,
  touchedPaths?: ReadonlyArray<ReadonlyArray<string>>,
  env?: NodeJS.ProcessEnv,
): LegacyConfigIssue[] {
  return findLegacyConfigIssues(raw, sourceRaw, [
    ...collectChannelLegacyConfigRules(raw, touchedPaths, undefined, env),
    ...collectPluginLegacyConfigRules(raw, touchedPaths, env),
  ]);
}

export async function addDoctorLegacyIssues(
  snapshot: ConfigFileSnapshot,
  pluginMetadataSnapshot?: PluginMetadataSnapshot,
): Promise<ConfigFileSnapshot> {
  if (!snapshot.exists || isConfigReadFailure(snapshot)) {
    return snapshot;
  }
  const resolvedRaw = snapshot.sourceConfig ?? snapshot.config ?? {};
  const collect = () => {
    const sourceRaw = snapshot.parsed ?? resolvedRaw;
    const legacyIssues = findDoctorLegacyConfigIssues(resolvedRaw, sourceRaw);
    const ownerIssue = findLegacySystemAgentOwnerIssue(
      snapshot.sourceConfigBeforeMigrations ?? resolvedRaw,
    );
    if (ownerIssue) {
      legacyIssues.push(ownerIssue);
    }
    return legacyIssues.length === 0 ? snapshot : { ...snapshot, legacyIssues };
  };
  const metadata =
    pluginMetadataSnapshot ?? (await resolvePluginMetadataSnapshotAsync({ config: resolvedRaw }));
  return withPluginMetadataSnapshotScope(metadata, collect, { config: resolvedRaw });
}
