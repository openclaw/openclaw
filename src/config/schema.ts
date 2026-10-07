import crypto from "node:crypto";
import { pruneMapToMaxSize } from "../infra/map-size.js";
import type { PluginConfigUiHint } from "../plugins/manifest-types.js";
import { GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA } from "./bundled-channel-config-metadata.generated.js";
import { computeBaseConfigSchemaResponse } from "./schema-base.js";
import { applySharedChannelFieldHelp } from "./schema.channel-field-help.js";
import type { ConfigUiHint, ConfigUiHints } from "./schema.hints.js";
import { applySensitiveHints, applySensitiveUrlHints } from "./schema.hints.js";
import {
  asSchemaObject,
  type ConfigJsonSchemaObject as JsonSchemaObject,
  type ConfigSchemaResponse,
} from "./schema.shared.js";
import { applyConfigTierHints, applyResolvedConfigTierHints } from "./schema.tiers.js";

export { classifyConfigSchemaPathSegment, lookupConfigSchema } from "./schema.lookup.js";
export type { ConfigSchemaResponse } from "./schema.shared.js";

type ConfigSchema = Record<string, unknown>;

type JsonSchemaNode = Record<string, unknown>;

function isObjectSchema(schema: JsonSchemaObject): boolean {
  const type = schema.type;
  return (
    type === "object" ||
    (Array.isArray(type) && type.includes("object")) ||
    Boolean(schema.properties || schema.additionalProperties)
  );
}

function mergeObjectSchema(base: JsonSchemaObject, extension: JsonSchemaObject): JsonSchemaObject {
  const mergedRequired = new Set<string>([...(base.required ?? []), ...(extension.required ?? [])]);
  const merged: JsonSchemaObject = {
    ...base,
    ...extension,
    properties: {
      ...base.properties,
      ...extension.properties,
    },
  };
  if (mergedRequired.size > 0) {
    merged.required = Array.from(mergedRequired);
  }
  const additional = extension.additionalProperties ?? base.additionalProperties;
  if (additional !== undefined) {
    merged.additionalProperties = additional;
  }
  return merged;
}

export type PluginUiMetadata = {
  id: string;
  name?: string;
  description?: string;
  configSecretInputPaths?: readonly string[];
  configGroups?: ConfigUiHint["groups"];
  configUiHints?: Record<string, PluginConfigUiHint>;
  configSchema?: JsonSchemaNode;
};

export type ChannelUiMetadata = {
  id: string;
  label?: string;
  description?: string;
  configSchema?: JsonSchemaNode;
  configUiHints?: Record<string, ConfigUiHint>;
};

const EXTENSION_SCHEMA_MAX_BYTES = 256 * 1024;
const EXTENSION_SCHEMA_TOTAL_MAX_BYTES = 2 * 1024 * 1024;
const EXTENSION_SCHEMA_MAX_ITEMS = 256;

function schemaJsonBytes(schema: JsonSchemaNode): number {
  try {
    return Buffer.byteLength(JSON.stringify(schema), "utf-8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function buildOmittedExtensionConfigSchema(kind: "plugin" | "channel", id: string): JsonSchemaNode {
  return {
    type: "object",
    additionalProperties: true,
    description: `${kind} config schema for ${id} was omitted from the full config.schema response because installed extension schemas exceeded the Gateway response budget.`,
  };
}

function limitExtensionSchemas(params: {
  plugins: PluginUiMetadata[];
  channels: ChannelUiMetadata[];
}): { plugins: PluginUiMetadata[]; channels: ChannelUiMetadata[] } {
  let totalBytes = 0;
  let includedItems = 0;

  const keepSchema = (schema: JsonSchemaNode): boolean => {
    const bytes = schemaJsonBytes(schema);
    if (
      !Number.isFinite(bytes) ||
      bytes > EXTENSION_SCHEMA_MAX_BYTES ||
      totalBytes + bytes > EXTENSION_SCHEMA_TOTAL_MAX_BYTES ||
      includedItems >= EXTENSION_SCHEMA_MAX_ITEMS
    ) {
      return false;
    }
    totalBytes += bytes;
    includedItems += 1;
    return true;
  };

  const limitSchemas = <T extends PluginUiMetadata | ChannelUiMetadata>(
    entries: T[],
    kind: "plugin" | "channel",
  ): T[] =>
    entries.map((entry) =>
      !entry.configSchema || keepSchema(entry.configSchema)
        ? entry
        : { ...entry, configSchema: buildOmittedExtensionConfigSchema(kind, entry.id) },
    );

  return {
    plugins: limitSchemas(params.plugins, "plugin"),
    channels: limitSchemas(params.channels, "channel"),
  };
}

function collectExtensionHintKeys(
  hints: ConfigUiHints,
  plugins: PluginUiMetadata[],
  channels: ChannelUiMetadata[],
): Set<string> {
  const keys = new Set<string>();
  const hintKeys = Object.keys(hints);
  const collectPrefixedHintKeys = (prefix: string) => {
    const childPrefix = `${prefix}.`;
    for (const key of hintKeys) {
      if (key === prefix || key.startsWith(childPrefix)) {
        keys.add(key);
      }
    }
  };

  const collectSchemaKeys = (schema: unknown, basePath: string) => {
    const node = asSchemaObject(schema);
    if (!node) {
      return;
    }
    keys.add(basePath);
    for (const [propertyKey, propertySchema] of Object.entries(node.properties ?? {})) {
      collectSchemaKeys(propertySchema, `${basePath}.${propertyKey}`);
    }
    if (node.additionalProperties && typeof node.additionalProperties === "object") {
      collectSchemaKeys(node.additionalProperties, `${basePath}.*`);
    }
    for (const item of Array.isArray(node.items) ? node.items : [node.items]) {
      collectSchemaKeys(item, `${basePath}[]`);
    }
  };

  for (const plugin of plugins) {
    const id = plugin.id.trim();
    if (!id) {
      continue;
    }
    const prefix = `plugins.entries.${id}`;
    collectPrefixedHintKeys(prefix);
    collectSchemaKeys(plugin.configSchema, `${prefix}.config`);
  }

  for (const channel of channels) {
    const id = channel.id.trim();
    if (!id) {
      continue;
    }
    const prefix = `channels.${id}`;
    collectPrefixedHintKeys(prefix);
    collectSchemaKeys(channel.configSchema, prefix);
  }

  return keys;
}

function applyMetadataHints(
  hints: ConfigUiHints,
  plugins: PluginUiMetadata[],
  channels: ChannelUiMetadata[],
): ConfigUiHints {
  const next: ConfigUiHints = { ...hints };
  const mergeRelativeHints = (basePath: string, uiHints?: ConfigUiHints) => {
    for (const [relPathRaw, hint] of Object.entries(uiHints ?? {})) {
      const relPath = relPathRaw.trim().replace(/^\./, "");
      if (!relPath) {
        continue;
      }
      const key = `${basePath}.${relPath}`;
      next[key] = { ...next[key], ...hint };
    }
  };

  for (const plugin of plugins) {
    const id = plugin.id.trim();
    if (!id) {
      continue;
    }
    const name = (plugin.name ?? id).trim() || id;
    const basePath = `plugins.entries.${id}`;

    next[basePath] = {
      ...next[basePath],
      label: name,
      help: plugin.description
        ? `${plugin.description} (plugin: ${id})`
        : `Plugin entry for ${id}.`,
    };
    next[`${basePath}.enabled`] = {
      ...next[`${basePath}.enabled`],
      label: `Enable ${name}`,
    };
    next[`${basePath}.config`] = {
      ...next[`${basePath}.config`],
      label: `${name} Config`,
      help: `Plugin-defined config payload for ${id}.`,
      ...(plugin.configGroups ? { groups: plugin.configGroups } : {}),
    };

    mergeRelativeHints(`${basePath}.config`, plugin.configUiHints);
    // Manifest paths remain authoritative when local $refs hide secret leaves.
    for (const relPath of plugin.configSecretInputPaths ?? []) {
      const key = `${basePath}.config.${relPath}`;
      next[key] = { ...next[key], sensitive: true };
    }
  }

  for (const channel of channels) {
    const id = channel.id.trim();
    if (!id) {
      continue;
    }
    const basePath = `channels.${id}`;
    const current = next[basePath] ?? {};
    const label = channel.label?.trim();
    const help = channel.description?.trim();
    next[basePath] = {
      ...current,
      ...(label ? { label } : {}),
      ...(help ? { help } : {}),
    };

    mergeRelativeHints(basePath, channel.configUiHints);
  }

  return next;
}

/** Mutate a caller-owned schema; cached inputs must be cloned before merging. */
function mergeExtensionSchemas(
  schema: ConfigSchema,
  channels: ChannelUiMetadata[],
  plugins?: PluginUiMetadata[],
): ConfigSchema {
  const root = asSchemaObject(schema);
  const pluginsNode = asSchemaObject(root?.properties?.plugins);
  const entriesNode = asSchemaObject(pluginsNode?.properties?.entries);
  const entryBase = asSchemaObject(entriesNode?.additionalProperties);
  const entryProperties = entriesNode?.properties ?? {};
  if (entriesNode && plugins) {
    entriesNode.properties = entryProperties;
  }

  for (const plugin of plugins ?? []) {
    if (!entriesNode || !plugin.configSchema) {
      continue;
    }
    const entryObject: JsonSchemaObject = entryBase
      ? structuredClone(entryBase)
      : { type: "object" };
    const baseConfigSchema = asSchemaObject(entryObject.properties?.config);
    // The merged response owns plugin fragments independently of manifest metadata.
    const pluginConfigSchema = structuredClone(plugin.configSchema);
    const pluginSchema = asSchemaObject(pluginConfigSchema);
    const nextConfigSchema =
      baseConfigSchema &&
      pluginSchema &&
      isObjectSchema(baseConfigSchema) &&
      isObjectSchema(pluginSchema)
        ? mergeObjectSchema(baseConfigSchema, pluginSchema)
        : pluginConfigSchema;

    entryObject.properties = {
      ...entryObject.properties,
      config: nextConfigSchema,
    };
    entryProperties[plugin.id] = entryObject;
  }

  const channelsNode = asSchemaObject(root?.properties?.channels);
  if (!channelsNode) {
    return schema;
  }
  const channelProps = channelsNode.properties ?? {};
  channelsNode.properties = channelProps;

  for (const channel of channels) {
    if (!channel.configSchema) {
      continue;
    }
    const existing = asSchemaObject(channelProps[channel.id]);
    const incoming = asSchemaObject(channel.configSchema);
    if (existing && incoming && isObjectSchema(existing) && isObjectSchema(incoming)) {
      channelProps[channel.id] = mergeObjectSchema(existing, incoming);
    } else {
      channelProps[channel.id] = structuredClone(channel.configSchema);
    }
  }

  return schema;
}

let cachedBase: ConfigSchemaResponse | null = null;
const mergedSchemaCache = new Map<string, ConfigSchemaResponse>();
const MERGED_SCHEMA_CACHE_MAX = 64;

function buildMergedSchemaCacheKey(params: {
  plugins: PluginUiMetadata[];
  channels: ChannelUiMetadata[];
}): string {
  const plugins = params.plugins
    .map((plugin) => ({
      id: plugin.id,
      name: plugin.name,
      description: plugin.description,
      configSchema: plugin.configSchema ?? null,
      configSecretInputPaths: plugin.configSecretInputPaths ?? null,
      configUiHints: plugin.configUiHints ?? null,
      configGroups: plugin.configGroups ?? null,
    }))
    .toSorted((a, b) => a.id.localeCompare(b.id));
  const channels = params.channels
    .map((channel) => ({
      id: channel.id,
      label: channel.label,
      description: channel.description,
      configSchema: channel.configSchema ?? null,
      configUiHints: channel.configUiHints ?? null,
    }))
    .toSorted((a, b) => a.id.localeCompare(b.id));
  // Build the hash incrementally so we never materialize one giant JSON string.
  const hash = crypto.createHash("sha256");
  hash.update('{"plugins":[');
  plugins.forEach((plugin, index) => {
    if (index > 0) {
      hash.update(",");
    }
    hash.update(JSON.stringify(plugin));
  });
  hash.update('],"channels":[');
  channels.forEach((channel, index) => {
    if (index > 0) {
      hash.update(",");
    }
    hash.update(JSON.stringify(channel));
  });
  hash.update("]}");
  return hash.digest("hex");
}

function getBundledChannelSchemaMetadata(): ChannelUiMetadata[] {
  return GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA.map((entry) => {
    const metadata: ChannelUiMetadata = Object.assign(
      { id: entry.channelId },
      entry.label ? { label: entry.label } : {},
      entry.description ? { description: entry.description } : {},
      { configSchema: entry.schema },
    );
    if ("uiHints" in entry) {
      metadata.configUiHints = entry.uiHints as ChannelUiMetadata["configUiHints"];
    }
    return metadata;
  });
}

/**
 * Materialize the presentation hints that need the merged schema: tiers resolve
 * per path, then shared channel leaves get their help.
 */
function resolveMergedUiHints(
  schema: ConfigSchema,
  hints: ConfigUiHints,
  changedRoots: readonly string[],
): ConfigUiHints {
  // The base already resolved every core tier. Preserve schema order while
  // revisiting only roots whose plugin metadata changed their children.
  const root = asSchemaObject(schema);
  const changedSchema = {
    ...root,
    properties: Object.fromEntries(
      Object.entries(root?.properties ?? {}).filter(([key]) => changedRoots.includes(key)),
    ),
  };
  return applySharedChannelFieldHelp(
    applyResolvedConfigTierHints(
      changedSchema,
      applyConfigTierHints(hints, { includePluginOwnedChannels: true }),
    ),
  );
}

function buildBaseConfigSchema(): ConfigSchemaResponse {
  if (cachedBase) {
    return cachedBase;
  }
  const generated = computeBaseConfigSchemaResponse();
  const bundledChannels = getBundledChannelSchemaMetadata();
  const mergedWithoutSensitiveHints = applyMetadataHints(generated.uiHints, [], bundledChannels);
  const mergedHints = applySensitiveHints(
    mergedWithoutSensitiveHints,
    collectExtensionHintKeys(mergedWithoutSensitiveHints, [], bundledChannels),
  );
  const mergedSchema = mergeExtensionSchemas(generated.schema, bundledChannels);
  const next = {
    ...generated,
    schema: mergedSchema,
    uiHints: resolveMergedUiHints(mergedSchema, mergedHints, ["channels"]),
  };
  cachedBase = next;
  return next;
}

export function buildConfigSchemaCore(params?: {
  plugins?: PluginUiMetadata[];
  channels?: ChannelUiMetadata[];
  cache?: boolean;
}): ConfigSchemaResponse {
  const base = buildBaseConfigSchema();
  const { plugins, channels } = limitExtensionSchemas({
    plugins: params?.plugins ?? [],
    channels: params?.channels ?? [],
  });
  if (plugins.length === 0 && channels.length === 0) {
    return base;
  }
  const useCache = params?.cache !== false;
  const cacheKey = useCache ? buildMergedSchemaCacheKey({ plugins, channels }) : null;
  if (cacheKey) {
    const cached = mergedSchemaCache.get(cacheKey);
    if (cached) {
      return cached;
    }
  }
  const mergedWithoutSensitiveHints = applyMetadataHints(base.uiHints, plugins, channels);
  const extensionHintKeys = collectExtensionHintKeys(
    mergedWithoutSensitiveHints,
    plugins,
    channels,
  );
  const mergedHints = applySensitiveUrlHints(
    applySensitiveHints(mergedWithoutSensitiveHints, extensionHintKeys),
    extensionHintKeys,
  );
  const mergedSchema = mergeExtensionSchemas(structuredClone(base.schema), channels, plugins);
  const changedRoots = [
    ...(plugins.length ? ["plugins"] : []),
    ...(channels.length ? ["channels"] : []),
  ];
  const merged = {
    ...base,
    schema: mergedSchema,
    uiHints: resolveMergedUiHints(mergedSchema, mergedHints, changedRoots),
  };
  if (cacheKey) {
    pruneMapToMaxSize(mergedSchemaCache, MERGED_SCHEMA_CACHE_MAX - 1);
    mergedSchemaCache.set(cacheKey, merged);
  }
  return merged;
}
