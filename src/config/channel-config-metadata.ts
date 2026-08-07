/**
 * Converts plugin manifest metadata into deterministic config UI metadata for docs, validation, and runtime schema.
 * When multiple plugin origins expose the same id/channel, the closest origin owns the surfaced schema.
 */
import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizePluginsConfig } from "../plugins/config-state.js";
import { resolveManifestOwnerActivationState } from "../plugins/manifest-owner-policy.js";
import type { PluginManifestRecord, PluginManifestRegistry } from "../plugins/manifest-registry.js";
import type { PluginOrigin } from "../plugins/plugin-origin.types.js";
import type { ChannelUiMetadata, PluginUiMetadata } from "./schema.js";
import type { OpenClawConfig } from "./types.openclaw.js";
import { ChannelHeartbeatVisibilitySchema } from "./zod-schema.channels.js";

type ChannelSchemaMetadataWithOwnership = ChannelUiMetadata & {
  schemaPluginId?: string;
  schemaPluginOrigin?: PluginOrigin;
};

type ChannelMetadataRecord = ChannelSchemaMetadataWithOwnership & {
  originRank: number;
};

/** One plugin's claim on a channel id, with the policy facts that decide ownership. */
type ChannelSchemaClaim = {
  record: PluginManifestRecord;
  preferOver?: readonly string[];
  originRank: number;
  activated: boolean;
  explicitlyEnabled: boolean;
  behindCloserDeclaration: boolean;
};

type ChannelDmAllowFromMode = "topOnly" | "topOrNested" | "nestedOnly";

type ChannelDmPolicyMetadata = {
  id: string;
  dmAllowFromMode?: ChannelDmAllowFromMode;
};

type ChannelDmPolicyMetadataRecord = ChannelDmPolicyMetadata & {
  originRank: number;
};

const PLUGIN_ORIGIN_RANK: Readonly<Record<PluginOrigin, number>> = {
  // Lower ranks are closer to the operator and should override farther bundled/global metadata.
  config: 0,
  workspace: 1,
  global: 2,
  bundled: 3,
};

const CHANNEL_HEARTBEAT_VISIBILITY_JSON_SCHEMA =
  ChannelHeartbeatVisibilitySchema.unwrap().toJSONSchema({ target: "draft-07" });

function normalizeCoreOwnedChannelSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const normalized = structuredClone(schema);
  let changed = false;
  const normalizeNode = (
    node: Record<string, unknown>,
    accountMap = false,
    rootScope = true,
  ): void => {
    let withinRootScope = rootScope && (node === normalized || typeof node.$id !== "string");
    if (typeof node.$ref === "string") {
      const match = withinRootScope
        ? /^#\/(\$defs|definitions)\/([A-Za-z0-9_.-]+)$/.exec(node.$ref)
        : null;
      const definitions = match?.[1] ? normalized[match[1]] : undefined;
      const target = isRecord(definitions) && match?.[2] ? definitions[match[2]] : undefined;
      if (
        !isRecord(target) ||
        Object.keys(node).some(
          (key) => !["$ref", "$defs", "definitions", "$id", "$schema"].includes(key),
        ) ||
        ["$id", "$anchor", "$dynamicAnchor", "$recursiveAnchor", "$schema", "$ref"].some((key) =>
          Object.hasOwn(target, key),
        )
      ) {
        return;
      }
      // Inline only this owner; changing shared definitions would affect unrelated consumers.
      const owner = { ...node };
      Object.assign(node, structuredClone(target), owner);
      delete node.$ref;
      changed = true;
      withinRootScope = node === normalized;
    }

    for (const key of ["allOf", "anyOf", "oneOf"] as const) {
      const variants = node[key];
      for (const variant of Array.isArray(variants) ? variants : []) {
        if (isRecord(variant)) {
          normalizeNode(variant, accountMap, withinRootScope);
        }
      }
    }

    if (accountMap) {
      if (node.additionalProperties === true) {
        node.additionalProperties = {};
        changed = true;
      }
      const entries = [
        node.additionalProperties,
        ...Object.values(isRecord(node.properties) ? node.properties : {}),
        ...Object.values(isRecord(node.patternProperties) ? node.patternProperties : {}),
      ];
      for (const entry of entries) {
        if (isRecord(entry)) {
          normalizeNode(entry, false, withinRootScope);
        }
      }
      return;
    }

    const properties = isRecord(node.properties) ? node.properties : {};
    if (
      JSON.stringify(properties.heartbeatVisibility) !==
      JSON.stringify(CHANNEL_HEARTBEAT_VISIBILITY_JSON_SCHEMA)
    ) {
      node.properties = {
        ...properties,
        heartbeatVisibility: CHANNEL_HEARTBEAT_VISIBILITY_JSON_SCHEMA,
      };
      changed = true;
    }

    // Account maps are containers; only each account entry owns heartbeat visibility.
    const accounts = properties.accounts;
    if (isRecord(accounts)) {
      normalizeNode(accounts, true, withinRootScope);
    }
  };

  normalizeNode(normalized);
  return changed ? normalized : schema;
}

function declaresChannelPreferenceOver(
  preferOver: readonly string[] | undefined,
  pluginId: string | undefined,
): boolean {
  const target = pluginId?.trim().toLowerCase();
  if (!target) {
    return false;
  }
  return (preferOver ?? []).some((entry) => entry.trim().toLowerCase() === target);
}

function keepHighestRanked<T>(claims: readonly T[], rank: (claim: T) => number): readonly T[] {
  const best = Math.max(...claims.map(rank));
  return claims.filter((claim) => rank(claim) === best);
}

/** Ranks a claim above the claims it supersedes and below the claims that supersede it. */
function channelReplacementRank(
  claim: ChannelSchemaClaim,
  claims: readonly ChannelSchemaClaim[],
): number {
  const supersedes = claims.some(
    (other) => other !== claim && declaresChannelPreferenceOver(claim.preferOver, other.record.id),
  );
  const superseded = claims.some(
    (other) => other !== claim && declaresChannelPreferenceOver(other.preferOver, claim.record.id),
  );
  return (supersedes ? 1 : 0) - (superseded ? 1 : 0);
}

/**
 * Selects one owner across every claim on a channel id, strongest tier first: effective plugin
 * policy (metadata snapshots keep disabled plugins, and an inactive plugin must never own the
 * schema that validates a live channel), then origin closeness, then explicit operator selection
 * (runtime only supersedes an implicitly selected plugin, so an explicit one keeps the schema that
 * validates its existing keys), then the declared preferOver replacement, then the incumbent a
 * closer-origin declaration already froze. Claims that tie on every tier keep the last-claim-wins
 * registry order.
 */
function selectChannelSchemaOwner(claims: readonly ChannelSchemaClaim[]): PluginManifestRecord {
  let eligible = keepHighestRanked(claims, (claim) => (claim.activated ? 1 : 0));
  eligible = keepHighestRanked(eligible, (claim) => -claim.originRank);
  eligible = keepHighestRanked(eligible, (claim) => (claim.explicitlyEnabled ? 1 : 0));
  const contenders = eligible;
  eligible = keepHighestRanked(contenders, (claim) => channelReplacementRank(claim, contenders));
  const owners = keepHighestRanked(eligible, (claim) => (claim.behindCloserDeclaration ? 0 : 1));
  return expectDefined(owners.at(-1), "channel schema owner").record;
}

/** Resolves the winning channel config claim per channel id before any metadata is written. */
function selectChannelSchemaOwners(
  registry: PluginManifestRegistry,
  config?: OpenClawConfig,
): Map<string, PluginManifestRecord> {
  // Without config every plugin counts as an equally eligible owner, which keeps registry-only
  // callers (docs baseline, contract tests) on pure manifest metadata.
  const normalizedPlugins = config ? normalizePluginsConfig(config.plugins) : undefined;
  const claimsByChannelId = new Map<string, ChannelSchemaClaim[]>();
  const closestDeclaredRank = new Map<string, number>();
  const declareChannel = (channelId: string, originRank: number): void => {
    const closest = closestDeclaredRank.get(channelId);
    if (closest === undefined || originRank < closest) {
      closestDeclaredRank.set(channelId, originRank);
    }
  };

  for (const record of registry.plugins) {
    const originRank = PLUGIN_ORIGIN_RANK[record.origin] ?? Number.MAX_SAFE_INTEGER;
    for (const channelId of record.channels) {
      declareChannel(channelId, originRank);
    }
    const channelConfigs = Object.entries(record.channelConfigs ?? {});
    if (channelConfigs.length === 0) {
      continue;
    }
    const activation = normalizedPlugins
      ? resolveManifestOwnerActivationState({
          plugin: record,
          normalizedConfig: normalizedPlugins,
          rootConfig: config,
        })
      : { activated: true, explicitlyEnabled: false };
    for (const [channelId, channelConfig] of channelConfigs) {
      const claim: ChannelSchemaClaim = {
        record,
        preferOver: channelConfig.preferOver,
        originRank,
        activated: activation.activated,
        explicitlyEnabled: activation.explicitlyEnabled,
        // A closer-origin plugin that declared this channel id first keeps the incumbent owner,
        // so a farther-origin claim behind it cannot take a schema that closer metadata shadows.
        behindCloserDeclaration: (closestDeclaredRank.get(channelId) ?? originRank) < originRank,
      };
      declareChannel(channelId, originRank);
      const claims = claimsByChannelId.get(channelId);
      if (claims) {
        claims.push(claim);
      } else {
        claimsByChannelId.set(channelId, [claim]);
      }
    }
  }

  return new Map(
    [...claimsByChannelId].map(([channelId, claims]) => [
      channelId,
      selectChannelSchemaOwner(claims),
    ]),
  );
}

/** Collects plugin config UI metadata with deterministic origin precedence and output ordering. */
export function collectPluginSchemaMetadata(registry: PluginManifestRegistry): PluginUiMetadata[] {
  const deduped = new Map<
    string,
    PluginUiMetadata & {
      originRank: number;
    }
  >();

  for (const record of registry.plugins) {
    const current = deduped.get(record.id);
    const nextRank = PLUGIN_ORIGIN_RANK[record.origin] ?? Number.MAX_SAFE_INTEGER;
    // Prefer the closest install origin when the same plugin id appears in multiple registries.
    if (current && current.originRank <= nextRank) {
      continue;
    }
    deduped.set(record.id, {
      id: record.id,
      name: record.name,
      description: record.description,
      configUiHints: record.configUiHints,
      configSchema: record.configSchema,
      originRank: nextRank,
    });
  }

  return [...deduped.values()]
    .toSorted((left, right) => left.id.localeCompare(right.id))
    .map(({ originRank: _originRank, ...record }) => record);
}

/** Collects per-channel config metadata with the plugin that supplied the selected schema. */
export function collectChannelSchemaMetadataWithOwnership(
  registry: PluginManifestRegistry,
  config?: OpenClawConfig,
): ChannelSchemaMetadataWithOwnership[] {
  const byChannelId = new Map<string, ChannelMetadataRecord>();
  const schemaOwners = selectChannelSchemaOwners(registry, config);

  for (const record of registry.plugins) {
    const originRank = PLUGIN_ORIGIN_RANK[record.origin] ?? Number.MAX_SAFE_INTEGER;
    const rootLabel = record.channelCatalogMeta?.label;
    const rootDescription = record.channelCatalogMeta?.blurb;

    for (const channelId of record.channels) {
      const current = byChannelId.get(channelId);
      // Root channel catalog metadata can fill labels/descriptions before a channel-specific
      // config block appears, but it must not overwrite a closer-origin channel entry.
      if (!current || originRank <= current.originRank) {
        byChannelId.set(channelId, {
          id: channelId,
          label: rootLabel ?? current?.label,
          description: rootDescription ?? current?.description,
          configSchema: current?.configSchema,
          configUiHints: current?.configUiHints,
          schemaPluginId: current?.schemaPluginId,
          schemaPluginOrigin: current?.schemaPluginOrigin,
          originRank,
        });
      }
    }

    for (const [channelId, channelConfig] of Object.entries(record.channelConfigs ?? {})) {
      // Ownership is decided across every claim on this channel id before any metadata is
      // written, so registry traversal order can no longer overwrite the selected owner.
      if (schemaOwners.get(channelId) !== record) {
        continue;
      }
      const current = byChannelId.get(channelId);
      byChannelId.set(channelId, {
        id: channelId,
        label: channelConfig.label ?? rootLabel ?? current?.label,
        description: channelConfig.description ?? rootDescription ?? current?.description,
        // Installed plugin schemas can lag core; bundled schemas share its release and identity.
        configSchema:
          record.origin === "bundled" || channelConfig.schema === undefined
            ? channelConfig.schema
            : normalizeCoreOwnedChannelSchema(channelConfig.schema),
        configUiHints: channelConfig.uiHints as ChannelUiMetadata["configUiHints"],
        schemaPluginId: channelConfig.schema === undefined ? undefined : record.id,
        schemaPluginOrigin: channelConfig.schema === undefined ? undefined : record.origin,
        originRank,
      });
    }
  }

  return [...byChannelId.values()]
    .toSorted((left, right) => left.id.localeCompare(right.id))
    .map(({ originRank: _originRank, ...entry }) => entry);
}

/** Collects public per-channel config UI metadata without internal schema ownership. */
export function collectChannelSchemaMetadata(
  registry: PluginManifestRegistry,
  config?: OpenClawConfig,
): ChannelUiMetadata[] {
  return collectChannelSchemaMetadataWithOwnership(registry, config).map(
    ({ schemaPluginId: _schemaPluginId, schemaPluginOrigin: _schemaPluginOrigin, ...entry }) =>
      entry,
  );
}

/** Collects channel DM policy metadata without importing doctor/runtime command modules. */
export function collectChannelDmPolicyMetadata(
  registry: PluginManifestRegistry,
): ChannelDmPolicyMetadata[] {
  const byChannelId = new Map<string, ChannelDmPolicyMetadataRecord>();

  const put = (
    channelId: string | undefined,
    originRank: number,
    dmAllowFromMode?: ChannelDmAllowFromMode,
  ): void => {
    const id = channelId?.trim();
    if (!id) {
      return;
    }
    const current = byChannelId.get(id);
    if (current && current.originRank < originRank) {
      return;
    }
    byChannelId.set(id, {
      id,
      ...(dmAllowFromMode ? { dmAllowFromMode } : {}),
      originRank,
    });
  };

  for (const record of registry.plugins) {
    const originRank = PLUGIN_ORIGIN_RANK[record.origin] ?? Number.MAX_SAFE_INTEGER;
    const packageChannelId = record.packageChannel?.id?.trim();
    const dmAllowFromMode = record.packageChannel?.doctorCapabilities?.dmAllowFromMode;
    for (const channelId of record.channels) {
      put(channelId, originRank, channelId === packageChannelId ? dmAllowFromMode : undefined);
    }
    put(packageChannelId, originRank, dmAllowFromMode);
    for (const channelId of Object.keys(record.channelConfigs ?? {})) {
      put(channelId, originRank, channelId === packageChannelId ? dmAllowFromMode : undefined);
    }
  }

  return [...byChannelId.values()]
    .toSorted((left, right) => left.id.localeCompare(right.id))
    .map(({ originRank: _originRank, ...entry }) => entry);
}
