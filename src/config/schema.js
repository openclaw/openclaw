import crypto from "node:crypto";
import { CHANNEL_IDS } from "../channels/ids.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA } from "./bundled-channel-config-metadata.generated.js";
import { GENERATED_BASE_CONFIG_SCHEMA } from "./schema.base.generated.js";
import { applySensitiveHints, applySensitiveUrlHints } from "./schema.hints.js";
import { asSchemaObject, cloneSchema, findWildcardHintMatch, schemaHasChildren, } from "./schema.shared.js";
import { applyDerivedTags } from "./schema.tags.js";
const asJsonSchemaObject = (value) => asSchemaObject(value);
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
function isObjectSchema(schema) {
    const type = schema.type;
    if (type === "object") {
        return true;
    }
    if (Array.isArray(type) && type.includes("object")) {
        return true;
    }
    return Boolean(schema.properties || schema.additionalProperties);
}
function mergeObjectSchema(base, extension) {
    const mergedRequired = new Set([...(base.required ?? []), ...(extension.required ?? [])]);
    const merged = {
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
function collectExtensionHintKeys(hints, plugins, channels) {
    const keys = new Set();
    const collectPrefixedHintKeys = (prefix) => {
        for (const key of Object.keys(hints)) {
            if (key === prefix || key.startsWith(`${prefix}.`)) {
                keys.add(key);
            }
        }
    };
    const collectSchemaKeys = (schema, basePath) => {
        const node = asJsonSchemaObject(schema);
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
        if (Array.isArray(node.items)) {
            for (const item of node.items) {
                if (item && typeof item === "object") {
                    collectSchemaKeys(item, `${basePath}[]`);
                }
            }
            return;
        }
        if (node.items && typeof node.items === "object") {
            collectSchemaKeys(node.items, `${basePath}[]`);
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
function applyPluginHints(hints, plugins) {
    const next = { ...hints };
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
function applyChannelHints(hints, channels) {
    const next = { ...hints };
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
function listHeartbeatTargetChannels(channels) {
    const seen = new Set();
    const ordered = [];
    for (const id of CHANNEL_IDS) {
        const normalized = normalizeLowercaseStringOrEmpty(id);
        if (!normalized || seen.has(normalized)) {
            continue;
        }
        seen.add(normalized);
        ordered.push(normalized);
    }
    for (const channel of channels) {
        const normalized = normalizeLowercaseStringOrEmpty(channel.id);
        if (!normalized || seen.has(normalized)) {
            continue;
        }
        seen.add(normalized);
        ordered.push(normalized);
    }
    return ordered;
}
function applyHeartbeatTargetHints(hints, channels) {
    const next = { ...hints };
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
function applyPluginSchemas(schema, plugins) {
    const next = cloneSchema(schema);
    const root = asJsonSchemaObject(next);
    const pluginsNode = asJsonSchemaObject(root?.properties?.plugins);
    const entriesNode = asJsonSchemaObject(pluginsNode?.properties?.entries);
    if (!entriesNode) {
        return next;
    }
    const entryBase = asJsonSchemaObject(entriesNode.additionalProperties);
    const entryProperties = entriesNode.properties ?? {};
    entriesNode.properties = entryProperties;
    for (const plugin of plugins) {
        if (!plugin.configSchema) {
            continue;
        }
        const entrySchema = entryBase
            ? cloneSchema(entryBase)
            : { type: "object" };
        const entryObject = asJsonSchemaObject(entrySchema) ?? { type: "object" };
        const baseConfigSchema = asJsonSchemaObject(entryObject.properties?.config);
        const pluginSchema = asJsonSchemaObject(plugin.configSchema);
        const nextConfigSchema = baseConfigSchema &&
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
function applyChannelSchemas(schema, channels) {
    const next = cloneSchema(schema);
    const root = asJsonSchemaObject(next);
    const channelsNode = asJsonSchemaObject(root?.properties?.channels);
    if (!channelsNode) {
        return next;
    }
    const channelProps = channelsNode.properties ?? {};
    channelsNode.properties = channelProps;
    for (const channel of channels) {
        if (!channel.configSchema) {
            continue;
        }
        const existing = asJsonSchemaObject(channelProps[channel.id]);
        const incoming = asJsonSchemaObject(channel.configSchema);
        if (existing && incoming && isObjectSchema(existing) && isObjectSchema(incoming)) {
            channelProps[channel.id] = mergeObjectSchema(existing, incoming);
        }
        else {
            channelProps[channel.id] = cloneSchema(channel.configSchema);
        }
    }
    return next;
}
let cachedBase = null;
const mergedSchemaCache = new Map();
const MERGED_SCHEMA_CACHE_MAX = 64;
function buildMergedSchemaCacheKey(params) {
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
function setMergedSchemaCache(key, value) {
    if (mergedSchemaCache.size >= MERGED_SCHEMA_CACHE_MAX) {
        const oldest = mergedSchemaCache.keys().next();
        if (!oldest.done) {
            mergedSchemaCache.delete(oldest.value);
        }
    }
    mergedSchemaCache.set(key, value);
}
function getBundledChannelSchemaMetadata() {
    return GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA.map((entry) => {
        const metadata = Object.assign({ id: entry.channelId }, entry.label ? { label: entry.label } : {}, entry.description ? { description: entry.description } : {}, { configSchema: entry.schema });
        if ("uiHints" in entry) {
            metadata.configUiHints = entry.uiHints;
        }
        return metadata;
    });
}
function buildBaseConfigSchema() {
    if (cachedBase) {
        return cachedBase;
    }
    const generated = GENERATED_BASE_CONFIG_SCHEMA;
    const bundledChannels = getBundledChannelSchemaMetadata();
    const mergedWithoutSensitiveHints = applyHeartbeatTargetHints(applyChannelHints(generated.uiHints, bundledChannels), bundledChannels);
    const mergedHints = applyDerivedTags(applySensitiveHints(mergedWithoutSensitiveHints, collectExtensionHintKeys(mergedWithoutSensitiveHints, [], bundledChannels)));
    const next = {
        ...generated,
        schema: applyChannelSchemas(generated.schema, bundledChannels),
        uiHints: mergedHints,
    };
    cachedBase = next;
    return next;
}
export function buildConfigSchema(params) {
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
    const mergedWithoutSensitiveHints = applyHeartbeatTargetHints(applyChannelHints(applyPluginHints(base.uiHints, plugins), channels), channels);
    const extensionHintKeys = collectExtensionHintKeys(mergedWithoutSensitiveHints, plugins, channels);
    const mergedHints = applyDerivedTags(applySensitiveUrlHints(applySensitiveHints(mergedWithoutSensitiveHints, extensionHintKeys), extensionHintKeys));
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
function normalizeLookupPath(path) {
    return path
        .trim()
        .replace(/\[(\*|\d*)\]/g, (_match, segment) => `.${segment || "*"}`)
        .replace(/^\.+|\.+$/g, "")
        .replace(/\.+/g, ".");
}
function splitLookupPath(path) {
    const normalized = normalizeLookupPath(path);
    return normalized ? normalized.split(".").filter(Boolean) : [];
}
function resolveUiHintMatch(uiHints, path) {
    return findWildcardHintMatch({
        uiHints,
        path,
        splitPath: splitLookupPath,
    });
}
function resolveItemsSchema(schema, index) {
    if (Array.isArray(schema.items)) {
        const entry = index === undefined
            ? schema.items.find((candidate) => typeof candidate === "object" && candidate !== null)
            : schema.items[index];
        return entry && typeof entry === "object" ? entry : null;
    }
    return schema.items && typeof schema.items === "object" ? schema.items : null;
}
function resolveLookupChildSchema(schema, segment) {
    if (FORBIDDEN_LOOKUP_SEGMENTS.has(segment)) {
        return null;
    }
    const properties = schema.properties;
    if (properties && Object.hasOwn(properties, segment)) {
        return asJsonSchemaObject(properties[segment]);
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
function stripSchemaForLookup(schema) {
    const next = {};
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
            }
            else if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
                next[key] = [...value];
            }
            continue;
        }
        if (key === "enum" && Array.isArray(value)) {
            const entries = value.filter((entry) => entry === null ||
                typeof entry === "string" ||
                typeof entry === "number" ||
                typeof entry === "boolean");
            if (entries.length === value.length) {
                next[key] = [...entries];
            }
            continue;
        }
        if (key === "const" &&
            (value === null ||
                typeof value === "string" ||
                typeof value === "number" ||
                typeof value === "boolean")) {
            next[key] = value;
        }
    }
    return next;
}
function buildLookupChildren(schema, path, uiHints) {
    const children = [];
    const required = new Set(schema.required ?? []);
    const pushChild = (key, childSchema, isRequired) => {
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
    const wildcardSchema = (schema.additionalProperties &&
        typeof schema.additionalProperties === "object" &&
        !Array.isArray(schema.additionalProperties)
        ? schema.additionalProperties
        : null) ?? resolveItemsSchema(schema);
    if (wildcardSchema) {
        pushChild("*", wildcardSchema, false);
    }
    return children;
}
export function lookupConfigSchema(response, path) {
    const normalizedPath = normalizeLookupPath(path);
    if (!normalizedPath) {
        return null;
    }
    const parts = splitLookupPath(normalizedPath);
    if (parts.length === 0 || parts.length > MAX_LOOKUP_PATH_SEGMENTS) {
        return null;
    }
    let current = asJsonSchemaObject(response.schema);
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
