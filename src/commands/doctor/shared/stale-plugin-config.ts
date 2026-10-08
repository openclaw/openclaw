import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { sanitizeForLog } from "../../../../packages/terminal-core/src/ansi.js";
import { resolveAgentWorkspaceDir, tryResolveDefaultAgentId } from "../../../agents/agent-scope.js";
import { CHANNEL_IDS } from "../../../channels/ids.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  isExplicitPluginDisableMarker,
  isRetiredPluginId,
  normalizePluginId,
  normalizePluginsConfig,
} from "../../../plugins/config-state.js";
import { hasIncompletePluginDiscovery } from "../../../plugins/discovery-availability.js";
import { loadInstalledPluginIndexInstallRecordsSync } from "../../../plugins/installed-plugin-index-records.js";
import { loadManifestMetadataSnapshot } from "../../../plugins/manifest-contract-eligibility.js";
import { isActivatedManifestOwner } from "../../../plugins/manifest-owner-policy.js";
import type { PluginManifestRecord } from "../../../plugins/manifest-registry.js";
import {
  listOfficialExternalPluginCatalogEntries,
  resolveOfficialExternalPluginLookupIds,
} from "../../../plugins/official-external-plugin-catalog.js";
import { normalizePluginPolicyId } from "../../../plugins/plugin-policy-id.js";
import { defaultSlotIdForKey, type PluginSlotKey } from "../../../plugins/slots.js";
import { listMutableCodexRouteAgentEntries } from "./codex-route-agent-entries.js";
import {
  filterRepairableStalePluginHits,
  type StalePluginSurface,
} from "./stale-plugin-repair-preservation.js";

const CHANNEL_CONFIG_META_KEYS = new Set(["defaults", "modelByChannel"]);

type StalePluginConfigHit = {
  pluginId: string;
  pathLabel: string;
  surface: StalePluginSurface;
  slotKey?: PluginSlotKey;
};

type StalePluginRegistryState = {
  plugins: PluginManifestRecord[];
  knownIds: Set<string>;
  officialLookupIds: Set<string>;
  knownChannelIds: Set<string>;
  missingInstalledIds: Set<string>;
  incompleteDiscovery: boolean;
};

function collectPluginRegistryState(
  cfg: OpenClawConfig,
  env?: NodeJS.ProcessEnv,
): StalePluginRegistryState {
  const environment = env ?? process.env;
  const defaultAgentId = tryResolveDefaultAgentId(cfg);
  const workspaceDir = defaultAgentId ? resolveAgentWorkspaceDir(cfg, defaultAgentId) : undefined;
  const registry = loadManifestMetadataSnapshot({
    config: cfg,
    workspaceDir: workspaceDir ?? undefined,
    env: environment,
  }).manifestRegistry;
  const knownIds = new Set(registry.plugins.map((plugin) => plugin.id));
  // Official catalog config remains valid even when its package is not installed yet.
  const officialLookupIds = new Set(
    listOfficialExternalPluginCatalogEntries()
      .flatMap((entry) => resolveOfficialExternalPluginLookupIds(entry).map(normalizePluginId))
      .filter(Boolean),
  );
  const installedIds = new Set(
    Object.keys(cfg.plugins?.installs ?? {})
      .map(normalizePluginId)
      .filter(Boolean),
  );
  try {
    for (const pluginId of Object.keys(
      loadInstalledPluginIndexInstallRecordsSync({ env: environment }),
    )) {
      const normalized = normalizePluginId(pluginId);
      if (normalized) {
        installedIds.add(normalized);
      }
    }
  } catch {
    // Missing/corrupt install-record state must not block normal doctor scans.
  }
  const knownChannelIds = new Set(
    [...CHANNEL_IDS, ...registry.plugins.flatMap((plugin) => plugin.channels)]
      .map(normalizePluginId)
      .filter(Boolean),
  );
  return {
    plugins: registry.plugins,
    knownIds,
    officialLookupIds,
    knownChannelIds,
    missingInstalledIds: new Set([...installedIds].filter((pluginId) => !knownIds.has(pluginId))),
    incompleteDiscovery: hasIncompletePluginDiscovery(registry.diagnostics),
  };
}

/** Incomplete discovery cannot prove that a configured plugin should be removed. */
export function isStalePluginAutoRepairBlocked(
  cfg: OpenClawConfig,
  env?: NodeJS.ProcessEnv,
): boolean {
  if (cfg.plugins?.enabled === false) {
    return false;
  }
  return collectPluginRegistryState(cfg, env).incompleteDiscovery;
}

/** Scan plugin/channel config surfaces for ids no longer present in manifests or installs. */
export function scanStalePluginConfig(
  cfg: OpenClawConfig,
  env?: NodeJS.ProcessEnv,
): StalePluginConfigHit[] {
  if (cfg.plugins?.enabled === false) {
    return [];
  }
  return scanStalePluginConfigWithState(cfg, collectPluginRegistryState(cfg, env));
}

function scanStalePluginConfigWithState(
  cfg: OpenClawConfig,
  registryState: StalePluginRegistryState,
): StalePluginConfigHit[] {
  const plugins = asNullableRecord(cfg.plugins);
  const { knownIds, officialLookupIds, knownChannelIds } = registryState;
  const isMissingPolicyOwner = (pluginId: string) =>
    pluginId &&
    !knownIds.has(pluginId) &&
    !officialLookupIds.has(pluginId) &&
    !knownChannelIds.has(pluginId);
  const hits: StalePluginConfigHit[] = [];
  const staleEvidenceIds = new Set(registryState.missingInstalledIds);

  for (const surface of ["allow", "deny"] as const) {
    const list = Array.isArray(plugins?.[surface]) ? plugins[surface] : [];
    for (const rawPluginId of list) {
      if (typeof rawPluginId !== "string") {
        continue;
      }
      const pluginId = normalizePluginId(rawPluginId);
      if (!isMissingPolicyOwner(pluginId)) {
        continue;
      }
      hits.push({ pluginId: rawPluginId, pathLabel: `plugins.${surface}`, surface });
      staleEvidenceIds.add(pluginId);
    }
  }

  for (const [rawPluginId, entry] of Object.entries(asNullableRecord(plugins?.entries) ?? {})) {
    const pluginId = normalizePluginId(rawPluginId);
    if (
      !isMissingPolicyOwner(pluginId) ||
      (isExplicitPluginDisableMarker(entry) && !isRetiredPluginId(pluginId))
    ) {
      continue;
    }
    hits.push({
      pluginId: rawPluginId,
      pathLabel: `plugins.entries.${rawPluginId}`,
      surface: "entries",
    });
    staleEvidenceIds.add(pluginId);
  }

  const slots = asNullableRecord(plugins?.slots);
  for (const slotKey of ["memory", "contextEngine"] as const satisfies readonly PluginSlotKey[]) {
    const rawPluginId = slots?.[slotKey];
    if (typeof rawPluginId !== "string") {
      continue;
    }
    const pluginId = normalizePluginId(rawPluginId);
    const defaultSlotId = defaultSlotIdForKey(slotKey);
    if (
      !pluginId ||
      rawPluginId.trim().toLowerCase() === "none" ||
      pluginId === normalizePluginId(defaultSlotId) ||
      knownIds.has(pluginId)
    ) {
      continue;
    }
    hits.push({
      pluginId: rawPluginId,
      pathLabel: `plugins.slots.${slotKey}`,
      surface: "slot",
      slotKey,
    });
  }

  const staleChannelIds = collectDanglingChannelIds({
    cfg,
    registryState,
    staleEvidenceIds,
  });
  for (const channelId of staleChannelIds) {
    hits.push({
      pluginId: channelId,
      pathLabel: `channels.${channelId}`,
      surface: "channel",
    });
  }
  hits.push(...collectDependentChannelConfigHits(cfg, staleChannelIds));

  return hits;
}

function collectDanglingChannelIds(params: {
  cfg: OpenClawConfig;
  registryState: StalePluginRegistryState;
  staleEvidenceIds: ReadonlySet<string>;
}): string[] {
  const channels = asNullableRecord(params.cfg.channels);
  if (!channels) {
    return [];
  }
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const channelId of Object.keys(channels)) {
    if (CHANNEL_CONFIG_META_KEYS.has(channelId)) {
      continue;
    }
    const normalized = normalizePluginId(channelId);
    if (
      !normalized ||
      params.registryState.knownChannelIds.has(normalized) ||
      !params.staleEvidenceIds.has(normalized) ||
      seen.has(normalized)
    ) {
      continue;
    }
    seen.add(normalized);
    ids.push(channelId);
  }
  return ids;
}

function collectDependentChannelConfigHits(
  cfg: OpenClawConfig,
  channelIds: readonly string[],
): StalePluginConfigHit[] {
  if (channelIds.length === 0) {
    return [];
  }
  const staleChannelIds = new Set(channelIds.map((channelId) => normalizePluginId(channelId)));
  const hits: StalePluginConfigHit[] = [];
  for (const { agent, path } of [
    { agent: cfg.agents?.defaults, path: "agents.defaults" },
    ...listMutableCodexRouteAgentEntries(cfg),
  ]) {
    const heartbeat = asNullableRecord(agent?.heartbeat);
    const target = heartbeat?.target;
    if (typeof target !== "string" || !staleChannelIds.has(normalizePluginId(target))) {
      continue;
    }
    hits.push({
      pluginId: target,
      pathLabel: `${path}.heartbeat.target`,
      surface: "heartbeat",
    });
  }

  for (const [providerId, channelMap] of Object.entries(
    asNullableRecord(cfg.channels?.modelByChannel) ?? {},
  )) {
    for (const channelId of Object.keys(asNullableRecord(channelMap) ?? {})) {
      if (!staleChannelIds.has(normalizePluginId(channelId))) {
        continue;
      }
      hits.push({
        pluginId: channelId,
        pathLabel: `channels.modelByChannel.${providerId}.${channelId}`,
        surface: "modelByChannel",
      });
    }
  }

  return hits;
}

// Policy-list hits collapse into one grouped warning line instead of one line per path.
const isPolicySurfaceHit = (hit: StalePluginConfigHit) =>
  hit.surface === "allow" || hit.surface === "deny" || hit.surface === "entries";

function formatStalePluginHitWarning(hit: StalePluginConfigHit): string | null {
  if (isPolicySurfaceHit(hit)) {
    return null;
  }
  if (hit.surface === "slot") {
    return `- ${hit.pathLabel}: slot references missing plugin "${hit.pluginId}".`;
  }
  if (hit.surface === "channel") {
    return `- ${hit.pathLabel}: dangling channel config for missing plugin "${hit.pluginId}" was found.`;
  }
  if (hit.surface === "heartbeat") {
    return `- ${hit.pathLabel}: heartbeat target references missing channel plugin "${hit.pluginId}".`;
  }
  return `- ${hit.pathLabel}: model override references missing channel plugin "${hit.pluginId}".`;
}

/** Format warnings for stale plugin config hits. */
export function collectStalePluginConfigWarnings(params: {
  hits: StalePluginConfigHit[];
  doctorFixCommand: string;
  autoRepairBlocked?: boolean;
  surfacePreservePluginIds?: Partial<Record<StalePluginSurface, Iterable<string>>>;
}): string[] {
  const hits = filterRepairableStalePluginHits(params);
  if (hits.length === 0) {
    return [];
  }
  const policyPluginIds = [
    ...new Set(hits.filter(isPolicySurfaceHit).map((hit) => hit.pluginId)),
  ].toSorted((a, b) => a.localeCompare(b));
  const lines = hits
    .map((hit) => formatStalePluginHitWarning(hit))
    .filter((line): line is string => line !== null);
  if (policyPluginIds.length > 0) {
    lines.unshift(
      `- Stale plugin references (plugins.allow/deny/entries): ${policyPluginIds.join(", ")}.`,
    );
  }
  if (params.autoRepairBlocked) {
    lines.push(
      `- Auto-removal is paused because plugin discovery is incomplete; uninspected configuration is preserved. Resolve the plugin discovery diagnostics, then rerun "${params.doctorFixCommand}".`,
    );
  } else {
    lines.push(
      `- Run "${params.doctorFixCommand}" to remove stale plugin ids and dangling channel references.`,
    );
  }
  return lines.map((line) => sanitizeForLog(line));
}

/** Remove stale plugin ids and dangling channel references when discovery is healthy. */
export function maybeRepairStalePluginConfig(
  cfg: OpenClawConfig,
  env?: NodeJS.ProcessEnv,
  params?: {
    preservePluginIds?: Iterable<string>;
    surfacePreservePluginIds?: Partial<Record<StalePluginSurface, Iterable<string>>>;
  },
): {
  config: OpenClawConfig;
  changes: string[];
  warnings?: string[];
} {
  if (cfg.plugins?.enabled === false) {
    return { config: cfg, changes: [] };
  }
  const registryState = collectPluginRegistryState(cfg, env);
  if (registryState.incompleteDiscovery) {
    return { config: cfg, changes: [] };
  }

  const hits = filterRepairableStalePluginHits({
    hits: scanStalePluginConfigWithState(cfg, registryState),
    preservePluginIds: params?.preservePluginIds,
    surfacePreservePluginIds: params?.surfacePreservePluginIds,
  });
  if (hits.length === 0) {
    return { config: cfg, changes: [] };
  }

  const next = structuredClone(cfg);
  const nextPlugins = asNullableRecord(next.plugins);
  const idsForSurface = (surface: StalePluginSurface) =>
    hits.filter((hit) => hit.surface === surface).map((hit) => hit.pluginId);

  let retainedAllowedIds: string[] = [];
  const allowIds = idsForSurface("allow");
  const denyIds = idsForSurface("deny");
  for (const surface of ["allow", "deny"] as const) {
    const ids = surface === "allow" ? allowIds : denyIds;
    const list = nextPlugins?.[surface];
    if (!nextPlugins || ids.length === 0 || !Array.isArray(list)) {
      continue;
    }
    const staleIds = new Set(ids.map((pluginId) => normalizePluginId(pluginId)));
    nextPlugins[surface] = list.filter(
      (pluginId) => typeof pluginId !== "string" || !staleIds.has(normalizePluginId(pluginId)),
    );
    // Preserve channel/slot bypasses without turning an emptied allowlist into unrestricted access.
    if (surface === "allow" && normalizePluginsConfig(next.plugins).allow.length === 0) {
      const config = normalizePluginsConfig(cfg.plugins);
      const activePlugins = registryState.plugins.filter((plugin) =>
        isActivatedManifestOwner({ plugin, normalizedConfig: config, rootConfig: cfg }),
      );
      const activePolicyIds = new Set(
        activePlugins.map((plugin) => normalizePluginPolicyId(plugin.id)),
      );
      const aliasedOwners = activePlugins.filter(
        (plugin) => !activePolicyIds.has(normalizePluginId(plugin.id)),
      );
      if (aliasedOwners.length > 0) {
        return {
          config: cfg,
          changes: [],
          warnings: [
            `- Stale plugin cleanup paused: preserving the restrictive plugins.allow policy because active plugin ids alias to other owners (${aliasedOwners.map((plugin) => `${plugin.id} -> ${normalizePluginId(plugin.id)}`).join(", ")}). Choose noncolliding allowed plugin ids, then rerun openclaw doctor --fix.`,
          ],
        };
      }
      retainedAllowedIds = activePlugins.map((plugin) => normalizePluginId(plugin.id));
      nextPlugins.allow = retainedAllowedIds;
      if (retainedAllowedIds.length === 0) {
        nextPlugins.enabled = false;
      }
    }
  }

  const entryIds = idsForSurface("entries");
  if (entryIds.length > 0) {
    const entries = asNullableRecord(nextPlugins?.entries);
    if (entries) {
      const staleEntryIds = new Set(entryIds.map((pluginId) => normalizePluginId(pluginId)));
      removeStalePluginKeys(entries, staleEntryIds);
    }
  }

  const slotHits = hits.filter(
    (hit): hit is StalePluginConfigHit & { slotKey: PluginSlotKey } =>
      hit.surface === "slot" && hit.slotKey !== undefined,
  );
  const slots = asNullableRecord(nextPlugins?.slots);
  if (slotHits.length > 0 && slots) {
    for (const hit of slotHits) {
      delete slots[hit.slotKey];
    }
    if (Object.keys(slots).length === 0 && nextPlugins) {
      delete nextPlugins.slots;
    }
  }

  const channelIds = idsForSurface("channel");
  if (channelIds.length > 0) {
    removeDanglingChannelReferences(next, channelIds);
  }

  const changes: string[] = [];
  const recordRemoval = (ids: string[], label: string, noun: string, plural = `${noun}s`) => {
    if (ids.length > 0) {
      changes.push(
        `- ${label}: removed ${ids.length} stale ${ids.length === 1 ? noun : plural} (${ids.join(", ")})`,
      );
    }
  };
  recordRemoval(allowIds, "plugins.allow", "plugin id");
  if (retainedAllowedIds.length > 0) {
    changes.push(
      `- plugins.allow: retained already enabled plugins as explicit allowlist entries (${retainedAllowedIds.join(", ")}); review this list when changing channels or plugin slots`,
    );
  }
  if (nextPlugins?.enabled === false) {
    changes.push(
      "- plugins.enabled: disabled plugins because no allowed plugins remain; review plugins.allow before enabling plugins",
    );
  }
  recordRemoval(denyIds, "plugins.deny", "plugin id");
  recordRemoval(entryIds, "plugins.entries", "plugin entry", "plugin entries");
  if (slotHits.length > 0) {
    changes.push(
      `- plugins.slots: reset ${slotHits.length} stale plugin slot${slotHits.length === 1 ? "" : "s"} (${slotHits.map((hit) => `${hit.slotKey}: ${hit.pluginId} -> ${defaultSlotIdForKey(hit.slotKey)}`).join(", ")})`,
    );
  }
  if (channelIds.length > 0) {
    recordRemoval(channelIds, "channels", "channel config");
    const heartbeatIds = idsForSurface("heartbeat");
    if (heartbeatIds.length > 0) {
      changes.push(
        `- agents heartbeat: removed ${heartbeatIds.length} stale heartbeat target${heartbeatIds.length === 1 ? "" : "s"} (${[...new Set(heartbeatIds)].join(", ")})`,
      );
    }
    const modelByChannelIds = idsForSurface("modelByChannel");
    if (modelByChannelIds.length > 0) {
      changes.push(
        `- channels.modelByChannel: removed ${modelByChannelIds.length} stale channel model override${modelByChannelIds.length === 1 ? "" : "s"} (${[...new Set(modelByChannelIds)].join(", ")})`,
      );
    }
  }

  return { config: next, changes };
}

function removeStalePluginKeys(
  record: Record<string, unknown>,
  staleIds: ReadonlySet<string>,
  preservedKeys?: ReadonlySet<string>,
) {
  for (const key of Object.keys(record)) {
    if (!preservedKeys?.has(key) && staleIds.has(normalizePluginId(key))) {
      delete record[key];
    }
  }
}

function removeDanglingChannelReferences(config: OpenClawConfig, channelIds: readonly string[]) {
  const staleChannelIds = new Set(channelIds.map((channelId) => normalizePluginId(channelId)));
  const channels = asNullableRecord(config.channels);
  if (channels) {
    removeStalePluginKeys(channels, staleChannelIds, CHANNEL_CONFIG_META_KEYS);

    const modelByChannel = asNullableRecord(channels.modelByChannel);
    if (modelByChannel) {
      for (const [providerId, channelMap] of Object.entries(modelByChannel)) {
        const channelsForProvider = asNullableRecord(channelMap);
        if (!channelsForProvider) {
          continue;
        }
        removeStalePluginKeys(channelsForProvider, staleChannelIds);
        if (Object.keys(channelsForProvider).length === 0) {
          delete modelByChannel[providerId];
        }
      }
      if (Object.keys(modelByChannel).length === 0) {
        delete channels.modelByChannel;
      }
    }
  }

  for (const agent of [
    config.agents?.defaults,
    ...listMutableCodexRouteAgentEntries(config).map((entry) => entry.agent),
  ]) {
    const heartbeat = asNullableRecord(agent?.heartbeat);
    if (
      heartbeat &&
      typeof heartbeat.target === "string" &&
      staleChannelIds.has(normalizePluginId(heartbeat.target))
    ) {
      delete heartbeat.target;
    }
  }
}
