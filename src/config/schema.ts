import crypto from "node:crypto";
import { CHANNEL_IDS } from "../channels/registry.js";
import { VERSION } from "../version.js";
import type { ConfigUiHint, ConfigUiHints } from "./schema.hints.js";
import { applySensitiveHints, buildBaseHints, mapSensitivePaths } from "./schema.hints.js";
import { findWildcardHintMatch, schemaHasChildren } from "./schema.shared.js";
import { applyDerivedTags } from "./schema.tags.js";
import { OpenClawSchema } from "./zod-schema.js";

export type { ConfigUiHint, ConfigUiHints } from "./schema.hints.js";

export type ConfigSchema = ReturnType<typeof OpenClawSchema.toJSONSchema>;

type JsonSchemaNode = Record<string, unknown>;

type JsonSchemaObject = JsonSchemaNode & {
  type?: string | string[];
  properties?: Record<string, JsonSchemaObject>;
  required?: string[];
  additionalProperties?: JsonSchemaObject | boolean;
  items?: JsonSchemaObject | JsonSchemaObject[];
};

const FORBIDDEN_LOOKUP_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);
const LOOKUP_SCHEMA_STRING_KEYS = new Set([
  "$id",
  "$schema",
  "title",
  "description",
  "format",
  "pattern",
  "contentEncoding",
  "contentMediaType",
]);
const LOOKUP_SCHEMA_NUMBER_KEYS = new Set([
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "minProperties",
  "maxProperties",
]);
const LOOKUP_SCHEMA_BOOLEAN_KEYS = new Set([
  "additionalProperties",
  "uniqueItems",
  "deprecated",
  "readOnly",
  "writeOnly",
]);
const MAX_LOOKUP_PATH_SEGMENTS = 32;

function cloneSchema<T>(value: T): T {
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

function asSchemaObject(value: unknown): JsonSchemaObject | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as JsonSchemaObject;
}

function isObjectSchema(schema: JsonSchemaObject): boolean {
  const type = schema.type;
  if (type === "object") {
    return true;
  }
  if (Array.isArray(type) && type.includes("object")) {
    return true;
  }
  return Boolean(schema.properties || schema.additionalProperties);
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

export type ConfigSchemaResponse = {
  schema: ConfigSchema;
  uiHints: ConfigUiHints;
  version: string;
  generatedAt: string;
};

export type ConfigSchemaLookupChild = {
  key: string;
  path: string;
  type?: string | string[];
  required: boolean;
  hasChildren: boolean;
  hint?: ConfigUiHint;
  hintPath?: string;
};

export type ConfigSchemaLookupResult = {
  path: string;
  schema: JsonSchemaNode;
  hint?: ConfigUiHint;
  hintPath?: string;
  children: ConfigSchemaLookupChild[];
};

export type PluginUiMetadata = {
  id: string;
  name?: string;
  description?: string;
  configUiHints?: Record<
    string,
    Pick<ConfigUiHint, "label" | "help" | "tags" | "advanced" | "sensitive" | "placeholder">
  >;
  configSchema?: JsonSchemaNode;
};

export type ChannelUiMetadata = {
  id: string;
  label?: string;
  description?: string;
  configSchema?: JsonSchemaNode;
  configUiHints?: Record<string, ConfigUiHint>;
};

function collectExtensionHintKeys(
  hints: ConfigUiHints,
  plugins: PluginUiMetadata[],
  channels: ChannelUiMetadata[],
): Set<string> {
  const pluginPrefixes = plugins
    .map((plugin) => plugin.id.trim())
    .filter(Boolean)
    .map((id) => `plugins.entries.${id}`);
  const channelPrefixes = channels
    .map((channel) => channel.id.trim())
    .filter(Boolean)
    .map((id) => `channels.${id}`);
  const prefixes = [...pluginPrefixes, ...channelPrefixes];

  return new Set(
    Object.keys(hints).filter((key) =>
      prefixes.some((prefix) => key === prefix || key.startsWith(`${prefix}.`)),
    ),
  );
}

function applyPluginHints(hints: ConfigUiHints, plugins: PluginUiMetadata[]): ConfigUiHints {
  const next: ConfigUiHints = { ...hints };
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
    };

    const uiHints = plugin.configUiHints ?? {};
    for (const [relPathRaw, hint] of Object.entries(uiHints)) {
      const relPath = relPathRaw.trim().replace(/^\./, "");
      if (!relPath) {
        continue;
      }
      const key = `${basePath}.config.${relPath}`;
      next[key] = {
        ...next[key],
        ...hint,
      };
    }
  }
  return next;
}

function applyChannelHints(hints: ConfigUiHints, channels: ChannelUiMetadata[]): ConfigUiHints {
  const next: ConfigUiHints = { ...hints };
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

    const uiHints = channel.configUiHints ?? {};
    for (const [relPathRaw, hint] of Object.entries(uiHints)) {
      const relPath = relPathRaw.trim().replace(/^\./, "");
      if (!relPath) {
        continue;
      }
      const key = `${basePath}.${relPath}`;
      next[key] = {
        ...next[key],
        ...hint,
      };
    }
  }
  return next;
}

function listHeartbeatTargetChannels(channels: ChannelUiMetadata[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const id of CHANNEL_IDS) {
    const normalized = id.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    ordered.push(normalized);
  }
  for (const channel of channels) {
    const normalized = channel.id.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    ordered.push(normalized);
  }
  return ordered;
}

function applyHeartbeatTargetHints(
  hints: ConfigUiHints,
  channels: ChannelUiMetadata[],
): ConfigUiHints {
  const next: ConfigUiHints = { ...hints };
  const channelList = listHeartbeatTargetChannels(channels);
  const channelHelp = channelList.length ? ` Known channels: ${channelList.join(", ")}.` : "";
  const help = `Delivery target ("last", "none", or a channel id).${channelHelp}`;
  const paths = ["agents.defaults.heartbeat.target", "agents.list.*.heartbeat.target"];
  for (const path of paths) {
    const current = next[path] ?? {};
    next[path] = {
      ...current,
      help: current.help ?? help,
      placeholder: current.placeholder ?? "last",
    };
  }
  return next;
}

function applyPluginSchemas(schema: ConfigSchema, plugins: PluginUiMetadata[]): ConfigSchema {
  const next = cloneSchema(schema);
  const root = asSchemaObject(next);
  const pluginsNode = asSchemaObject(root?.properties?.plugins);
  const entriesNode = asSchemaObject(pluginsNode?.properties?.entries);
  if (!entriesNode) {
    return next;
  }

  const entryBase = asSchemaObject(entriesNode.additionalProperties);
  const entryProperties = entriesNode.properties ?? {};
  entriesNode.properties = entryProperties;

  for (const plugin of plugins) {
    if (!plugin.configSchema) {
      continue;
    }
    const entrySchema = entryBase
      ? cloneSchema(entryBase)
      : ({ type: "object" } as JsonSchemaObject);
    const entryObject = asSchemaObject(entrySchema) ?? ({ type: "object" } as JsonSchemaObject);
    const baseConfigSchema = asSchemaObject(entryObject.properties?.config);
    const pluginSchema = asSchemaObject(plugin.configSchema);
    const nextConfigSchema =
      baseConfigSchema &&
      pluginSchema &&
      isObjectSchema(baseConfigSchema) &&
      isObjectSchema(pluginSchema)
        ? mergeObjectSchema(baseConfigSchema, pluginSchema)
        : cloneSchema(plugin.configSchema);

    entryObject.properties = {
      ...entryObject.properties,
      config: nextConfigSchema,
    };
    entryProperties[plugin.id] = entryObject;
  }

  return next;
}

function applyChannelSchemas(schema: ConfigSchema, channels: ChannelUiMetadata[]): ConfigSchema {
  const next = cloneSchema(schema);
  const root = asSchemaObject(next);
  const channelsNode = asSchemaObject(root?.properties?.channels);
  if (!channelsNode) {
    return next;
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
      channelProps[channel.id] = cloneSchema(channel.configSchema);
    }
  }

  return next;
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
      configUiHints: plugin.configUiHints ?? null,
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

function setMergedSchemaCache(key: string, value: ConfigSchemaResponse): void {
  if (mergedSchemaCache.size >= MERGED_SCHEMA_CACHE_MAX) {
    const oldest = mergedSchemaCache.keys().next();
    if (!oldest.done) {
      mergedSchemaCache.delete(oldest.value);
    }
  }
  mergedSchemaCache.set(key, value);
}

function stripChannelSchema(schema: ConfigSchema): ConfigSchema {
  const next = cloneSchema(schema);
  const root = asSchemaObject(next);
  if (!root || !root.properties) {
    return next;
  }
  // Allow `$schema` in config files for editor tooling, but hide it from the
  // Control UI form schema so it does not show up as a configurable section.
  delete root.properties.$schema;
  if (Array.isArray(root.required)) {
    root.required = root.required.filter((key) => key !== "$schema");
  }
  const channelsNode = asSchemaObject(root.properties.channels);
  if (channelsNode) {
    channelsNode.properties = {};
    channelsNode.required = [];
    channelsNode.additionalProperties = true;
  }
  return next;
}

function buildBaseConfigSchema(): ConfigSchemaResponse {
  if (cachedBase) {
    return cachedBase;
  }
  const schema = OpenClawSchema.toJSONSchema({
    target: "draft-07",
    unrepresentable: "any",
  });
  schema.title = "OpenClawConfig";
  const hints = applyDerivedTags(mapSensitivePaths(OpenClawSchema, "", buildBaseHints()));
  const next = {
    schema: stripChannelSchema(schema),
    uiHints: hints,
    version: VERSION,
    generatedAt: new Date().toISOString(),
  };
  cachedBase = next;
  return next;
}

export function buildConfigSchema(params?: {
  plugins?: PluginUiMetadata[];
  channels?: ChannelUiMetadata[];
  cache?: boolean;
}): ConfigSchemaResponse {
  const base = buildBaseConfigSchema();
  const plugins = params?.plugins ?? [];
  const channels = params?.channels ?? [];
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
  const mergedWithoutSensitiveHints = applyHeartbeatTargetHints(
    applyChannelHints(applyPluginHints(base.uiHints, plugins), channels),
    channels,
  );
  const extensionHintKeys = collectExtensionHintKeys(
    mergedWithoutSensitiveHints,
    plugins,
    channels,
  );
  const mergedHints = applyDerivedTags(
    applySensitiveHints(mergedWithoutSensitiveHints, extensionHintKeys),
  );
  const mergedSchema = applyChannelSchemas(applyPluginSchemas(base.schema, plugins), channels);
  const merged = {
    ...base,
    schema: mergedSchema,
    uiHints: mergedHints,
  };
  if (cacheKey) {
    setMergedSchemaCache(cacheKey, merged);
  }
  return merged;
}

function normalizeLookupPath(path: string): string {
  return path
    .trim()
    .replace(/\[(\*|\d*)\]/g, (_match, segment: string) => `.${segment || "*"}`)
    .replace(/^\.+|\.+$/g, "")
    .replace(/\.+/g, ".");
}

function splitLookupPath(path: string): string[] {
  const normalized = normalizeLookupPath(path);
  return normalized ? normalized.split(".").filter(Boolean) : [];
}

function resolveUiHintMatch(
  uiHints: ConfigUiHints,
  path: string,
): { path: string; hint: ConfigUiHint } | null {
  return findWildcardHintMatch({
    uiHints,
    path,
    splitPath: splitLookupPath,
  });
}

function resolveItemsSchema(schema: JsonSchemaObject, index?: number): JsonSchemaObject | null {
  if (Array.isArray(schema.items)) {
    const entry =
      index === undefined
        ? schema.items.find((candidate) => typeof candidate === "object" && candidate !== null)
        : schema.items[index];
    return entry && typeof entry === "object" ? entry : null;
  }
  return schema.items && typeof schema.items === "object" ? schema.items : null;
}

function resolveLookupChildSchema(
  schema: JsonSchemaObject,
  segment: string,
): JsonSchemaObject | null {
  if (FORBIDDEN_LOOKUP_SEGMENTS.has(segment)) {
    return null;
  }

  const properties = schema.properties;
  if (properties && Object.hasOwn(properties, segment)) {
    return asSchemaObject(properties[segment]);
  }

  const itemIndex = /^\d+$/.test(segment) ? Number.parseInt(segment, 10) : undefined;
  const items = resolveItemsSchema(schema, itemIndex);
  if ((segment === "*" || itemIndex !== undefined) && items) {
    return items;
  }

  if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
    return schema.additionalProperties;
  }

  return null;
}

function stripSchemaForLookup(schema: JsonSchemaObject): JsonSchemaNode {
  const next: JsonSchemaNode = {};

  for (const [key, value] of Object.entries(schema)) {
    if (LOOKUP_SCHEMA_STRING_KEYS.has(key) && typeof value === "string") {
      next[key] = value;
      continue;
    }
    if (LOOKUP_SCHEMA_NUMBER_KEYS.has(key) && typeof value === "number") {
      next[key] = value;
      continue;
    }
    if (LOOKUP_SCHEMA_BOOLEAN_KEYS.has(key) && typeof value === "boolean") {
      next[key] = value;
      continue;
    }
    if (key === "type") {
      if (typeof value === "string") {
        next[key] = value;
      } else if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
        next[key] = [...value];
      }
      continue;
    }
    if (key === "enum" && Array.isArray(value)) {
      const entries = value.filter(
        (entry) =>
          entry === null ||
          typeof entry === "string" ||
          typeof entry === "number" ||
          typeof entry === "boolean",
      );
      if (entries.length === value.length) {
        next[key] = [...entries];
      }
      continue;
    }
    if (
      key === "const" &&
      (value === null ||
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean")
    ) {
      next[key] = value;
    }
  }

  return next;
}

function buildLookupChildren(
  schema: JsonSchemaObject,
  path: string,
  uiHints: ConfigUiHints,
): ConfigSchemaLookupChild[] {
  const children: ConfigSchemaLookupChild[] = [];
  const required = new Set(schema.required ?? []);

  const pushChild = (key: string, childSchema: JsonSchemaObject, isRequired: boolean) => {
    const childPath = path ? `${path}.${key}` : key;
    const resolvedHint = resolveUiHintMatch(uiHints, childPath);
    children.push({
      key,
      path: childPath,
      type: childSchema.type,
      required: isRequired,
      hasChildren: schemaHasChildren(childSchema),
      hint: resolvedHint?.hint,
      hintPath: resolvedHint?.path,
    });
  };

  for (const [key, childSchema] of Object.entries(schema.properties ?? {})) {
    pushChild(key, childSchema, required.has(key));
  }

  const wildcardSchema =
    (schema.additionalProperties &&
    typeof schema.additionalProperties === "object" &&
    !Array.isArray(schema.additionalProperties)
      ? schema.additionalProperties
      : null) ?? resolveItemsSchema(schema);
  if (wildcardSchema) {
    pushChild("*", wildcardSchema, false);
  }

  return children;
}

export function lookupConfigSchema(
  response: ConfigSchemaResponse,
  path: string,
): ConfigSchemaLookupResult | null {
  const normalizedPath = normalizeLookupPath(path);
  if (!normalizedPath) {
    return null;
  }
  const parts = splitLookupPath(normalizedPath);
  if (parts.length === 0 || parts.length > MAX_LOOKUP_PATH_SEGMENTS) {
    return null;
  }

  let current = asSchemaObject(response.schema);
  if (!current) {
    return null;
  }
  for (const segment of parts) {
    const next = resolveLookupChildSchema(current, segment);
    if (!next) {
      return null;
    }
    current = next;
  }

  const resolvedHint = resolveUiHintMatch(response.uiHints, normalizedPath);
  return {
    path: normalizedPath,
    schema: stripSchemaForLookup(current),
    hint: resolvedHint?.hint,
    hintPath: resolvedHint?.path,
    children: buildLookupChildren(current, normalizedPath, response.uiHints),
  };
}
