import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveOpenClawPackageRootSync } from "../infra/openclaw-root.js";
import { FIELD_HELP } from "./schema.help.js";
import type { ConfigSchemaResponse } from "./schema.js";
import { findWildcardHintMatch, schemaHasChildren } from "./schema.shared.js";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

type JsonSchemaNode = Record<string, unknown>;

type JsonSchemaObject = JsonSchemaNode & {
  type?: string | string[];
  properties?: Record<string, JsonSchemaObject>;
  required?: string[];
  additionalProperties?: JsonSchemaObject | boolean;
  items?: JsonSchemaObject | JsonSchemaObject[];
  enum?: unknown[];
  default?: unknown;
  deprecated?: boolean;
  anyOf?: JsonSchemaObject[];
  allOf?: JsonSchemaObject[];
  oneOf?: JsonSchemaObject[];
};

type ChannelSurfaceMetadata = {
  id: string;
  label: string;
  description?: string;
  configSchema?: Record<string, unknown>;
  configUiHints?: ConfigSchemaResponse["uiHints"];
};

export type ConfigDocBaselineKind = "core" | "channel" | "plugin";

export type ConfigDocBaselineEntry = {
  path: string;
  kind: ConfigDocBaselineKind;
  type?: string | string[];
  required: boolean;
  enumValues?: JsonValue[];
  defaultValue?: JsonValue;
  deprecated: boolean;
  sensitive: boolean;
  tags: string[];
  label?: string;
  help?: string;
  hasChildren: boolean;
};

export type ConfigDocBaseline = {
  generatedBy: "scripts/generate-config-doc-baseline.ts";
  entries: ConfigDocBaselineEntry[];
};

export type ConfigDocBaselineStatefileRender = {
  json: string;
  jsonl: string;
  baseline: ConfigDocBaseline;
};

export type ConfigDocBaselineStatefileWriteResult = {
  changed: boolean;
  wrote: boolean;
  jsonPath: string;
  statefilePath: string;
};

const GENERATED_BY = "scripts/generate-config-doc-baseline.ts" as const;
const DEFAULT_JSON_OUTPUT = "docs/.generated/config-baseline.json";
const DEFAULT_STATEFILE_OUTPUT = "docs/.generated/config-baseline.jsonl";
let cachedConfigDocBaselinePromise: Promise<ConfigDocBaseline> | null = null;

function logConfigDocBaselineDebug(message: string): void {
  if (process.env.OPENCLAW_CONFIG_DOC_BASELINE_DEBUG === "1") {
    console.error(`[config-doc-baseline] ${message}`);
  }
}

function resolveRepoRoot(): string {
  const fromPackage = resolveOpenClawPackageRootSync({
    cwd: path.dirname(fileURLToPath(import.meta.url)),
    moduleUrl: import.meta.url,
  });
  if (fromPackage) {
    return fromPackage;
  }
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

function normalizeBaselinePath(rawPath: string): string {
  return rawPath
    .trim()
    .replace(/\[\]/g, ".*")
    .replace(/\[(\*|\d+)\]/g, ".*")
    .replace(/^\.+|\.+$/g, "")
    .replace(/\.+/g, ".");
}

function normalizeJsonValue(value: unknown): JsonValue | undefined {
  if (value === null) {
    return null;
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (Array.isArray(value)) {
    const normalized = value
      .map((entry) => normalizeJsonValue(entry))
      .filter((entry): entry is JsonValue => entry !== undefined);
    return normalized;
  }
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => {
      const normalized = normalizeJsonValue(entry);
      return normalized === undefined ? null : ([key, normalized] as const);
    })
    .filter((entry): entry is readonly [string, JsonValue] => entry !== null);

  return Object.fromEntries(entries);
}

function normalizeEnumValues(values: unknown[] | undefined): JsonValue[] | undefined {
  if (!values) {
    return undefined;
  }
  const normalized = values
    .map((entry) => normalizeJsonValue(entry))
    .filter((entry): entry is JsonValue => entry !== undefined);
  return normalized.length > 0 ? normalized : undefined;
}

function asSchemaObject(value: unknown): JsonSchemaObject | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as JsonSchemaObject;
}

function splitHintLookupPath(path: string): string[] {
  const normalized = normalizeBaselinePath(path);
  return normalized ? normalized.split(".").filter(Boolean) : [];
}

function resolveUiHintMatch(
  uiHints: ConfigSchemaResponse["uiHints"],
  path: string,
): ConfigSchemaResponse["uiHints"][string] | undefined {
  return findWildcardHintMatch({
    uiHints,
    path,
    splitPath: splitHintLookupPath,
  })?.hint;
}

function normalizeTypeValue(value: string | string[] | undefined): string | string[] | undefined {
  if (!value) {
    return undefined;
  }
  if (Array.isArray(value)) {
    const normalized = [...new Set(value)].toSorted((left, right) => left.localeCompare(right));
    return normalized.length === 1 ? normalized[0] : normalized;
  }
  return value;
}

function mergeTypeValues(
  left: string | string[] | undefined,
  right: string | string[] | undefined,
): string | string[] | undefined {
  const merged = new Set<string>();
  for (const value of [left, right]) {
    if (!value) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        merged.add(entry);
      }
      continue;
    }
    merged.add(value);
  }
  return normalizeTypeValue([...merged]);
}

function areJsonValuesEqual(left: JsonValue | undefined, right: JsonValue | undefined): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function mergeJsonValueArrays(
  left: JsonValue[] | undefined,
  right: JsonValue[] | undefined,
): JsonValue[] | undefined {
  if (!left?.length) {
    return right ? [...right] : undefined;
  }
  if (!right?.length) {
    return [...left];
  }

  const merged = new Map<string, JsonValue>();
  for (const value of [...left, ...right]) {
    merged.set(JSON.stringify(value), value);
  }
  return [...merged.entries()]
    .toSorted(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
    .map(([, value]) => value);
}

function mergeConfigDocBaselineEntry(
  current: ConfigDocBaselineEntry,
  next: ConfigDocBaselineEntry,
): ConfigDocBaselineEntry {
  const label = current.label === next.label ? current.label : (current.label ?? next.label);
  const help = current.help === next.help ? current.help : (current.help ?? next.help);
  const defaultValue = areJsonValuesEqual(current.defaultValue, next.defaultValue)
    ? (current.defaultValue ?? next.defaultValue)
    : undefined;

  return {
    path: current.path,
    kind: current.kind,
    type: mergeTypeValues(current.type, next.type),
    required: current.required && next.required,
    enumValues: mergeJsonValueArrays(current.enumValues, next.enumValues),
    defaultValue,
    deprecated: current.deprecated || next.deprecated,
    sensitive: current.sensitive || next.sensitive,
    tags: [...new Set([...current.tags, ...next.tags])].toSorted((left, right) =>
      left.localeCompare(right),
    ),
    label,
    help,
    hasChildren: current.hasChildren || next.hasChildren,
  };
}

function resolveEntryKind(configPath: string): ConfigDocBaselineKind {
  if (configPath.startsWith("channels.")) {
    return "channel";
  }
  if (configPath.startsWith("plugins.entries.")) {
    return "plugin";
  }
  return "core";
}

function resolveFirstExistingPath(candidates: string[]): string | null {
  for (const candidate of candidates) {
    try {
      fsSync.accessSync(candidate);
      return candidate;
    } catch {
      // Keep scanning for other source file variants.
    }
  }
  return null;
}

async function loadBundledConfigSchemaResponse(): Promise<ConfigSchemaResponse> {
  const [
    { listChannelPluginCatalogEntries },
    { loadPluginManifestRegistry },
    { buildConfigSchema },
  ] = await Promise.all([
    import("../channels/plugins/catalog.js"),
    import("../plugins/manifest-registry.js"),
    import("./schema.js"),
  ]);
  const repoRoot = resolveRepoRoot();
  const env = {
    ...process.env,
    HOME: os.tmpdir(),
    OPENCLAW_STATE_DIR: path.join(os.tmpdir(), "openclaw-config-doc-baseline-state"),
    OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(repoRoot, "extensions"),
  };

  const manifestRegistry = loadPluginManifestRegistry({
    cache: false,
    env,
    config: {},
  });
  const channelCatalogById = new Map(
    listChannelPluginCatalogEntries({
      workspaceDir: repoRoot,
      env,
    }).map((entry) => [entry.id, entry.meta] as const),
  );
  logConfigDocBaselineDebug(`loaded ${manifestRegistry.plugins.length} bundled plugin manifests`);
  const bundledChannelPlugins = manifestRegistry.plugins.filter(
    (plugin) => plugin.origin === "bundled" && plugin.channels.length > 0,
  );
  const channelPlugins =
    process.env.OPENCLAW_CONFIG_DOC_BASELINE_DEBUG === "1"
      ? await bundledChannelPlugins.reduce<Promise<ChannelSurfaceMetadata[]>>(
          async (promise, plugin) => {
            const loaded = await promise;
            const catalogMeta = channelCatalogById.get(plugin.id);
            const label = catalogMeta?.label ?? plugin.name ?? plugin.id;
            const description = catalogMeta?.blurb ?? plugin.description;
            loaded.push(
              (await loadChannelSurfaceMetadata(
                plugin.rootDir,
                plugin.id,
                label,
                description,
                repoRoot,
              )) ?? {
                id: plugin.id,
                label,
                description,
                configSchema: plugin.configSchema,
                configUiHints: plugin.configUiHints,
              },
            );
            return loaded;
          },
          Promise.resolve([]),
        )
      : await Promise.all(
          bundledChannelPlugins.map(async (plugin) => {
            const catalogMeta = channelCatalogById.get(plugin.id);
            const label = catalogMeta?.label ?? plugin.name ?? plugin.id;
            const description = catalogMeta?.blurb ?? plugin.description;
            return (
              (await loadChannelSurfaceMetadata(
                plugin.rootDir,
                plugin.id,
                label,
                description,
                repoRoot,
              )) ?? {
                id: plugin.id,
                label,
                description,
                configSchema: plugin.configSchema,
                configUiHints: plugin.configUiHints,
              }
            );
          }),
        );
  logConfigDocBaselineDebug(
    `loaded ${channelPlugins.length} bundled channel entries from channel surfaces`,
  );

  return buildConfigSchema({
    cache: false,
    plugins: manifestRegistry.plugins
      .filter((plugin) => plugin.origin === "bundled")
      .map((plugin) => ({
        id: plugin.id,
        name: plugin.name,
        description: plugin.description,
        configUiHints: plugin.configUiHints,
        configSchema: plugin.configSchema,
      })),
    channels: channelPlugins.map((entry) => ({
      id: entry.id,
      label: entry.label,
      description: entry.description,
      configSchema: entry.configSchema,
      configUiHints: entry.configUiHints,
    })),
  });
}

async function loadChannelSurfaceMetadata(
  rootDir: string,
  id: string,
  label: string,
  description: string | undefined,
  repoRoot: string,
): Promise<ChannelSurfaceMetadata | null> {
  logConfigDocBaselineDebug(`resolve channel config surface ${rootDir}`);
  const modulePath = resolveFirstExistingPath([
    path.join(rootDir, "src", "config-schema.ts"),
    path.join(rootDir, "src", "config-schema.js"),
    path.join(rootDir, "src", "config-schema.mts"),
    path.join(rootDir, "src", "config-schema.mjs"),
  ]);
  if (!modulePath) {
    logConfigDocBaselineDebug(`missing channel config schema module ${rootDir}`);
    return null;
  }

  logConfigDocBaselineDebug(`import channel config schema ${modulePath}`);
  try {
    const { loadChannelConfigSurfaceModule } =
      await import("../../scripts/load-channel-config-surface.ts");
    const configSurface = await loadChannelConfigSurfaceModule(modulePath, { repoRoot });
    if (!configSurface) {
      logConfigDocBaselineDebug(`channel config schema export missing ${modulePath}`);
      return null;
    }
    logConfigDocBaselineDebug(`completed channel config schema import ${modulePath}`);
    return {
      id,
      label,
      description,
      configSchema: configSurface.schema,
      configUiHints: configSurface.uiHints as ConfigSchemaResponse["uiHints"] | undefined,
    };
  } catch (error) {
    logConfigDocBaselineDebug(
      `channel config schema import failed for ${modulePath}: ${String(error)}`,
    );
    return null;
  }
}

export function collectConfigDocBaselineEntries(
  schema: JsonSchemaObject,
  uiHints: ConfigSchemaResponse["uiHints"],
  pathPrefix = "",
  required = false,
  entries: ConfigDocBaselineEntry[] = [],
  visited = new WeakMap<JsonSchemaObject, Set<string>>(),
): ConfigDocBaselineEntry[] {
  const normalizedPath = normalizeBaselinePath(pathPrefix);
  const visitKey = `${normalizedPath}|${required ? "1" : "0"}`;
  const visitedPaths = visited.get(schema);
  if (visitedPaths?.has(visitKey)) {
    return entries;
  }
  if (visitedPaths) {
    visitedPaths.add(visitKey);
  } else {
    visited.set(schema, new Set([visitKey]));
  }

  if (normalizedPath) {
    const hint = resolveUiHintMatch(uiHints, normalizedPath);
    entries.push({
      path: normalizedPath,
      kind: resolveEntryKind(normalizedPath),
      type: normalizeTypeValue(schema.type),
      required,
      enumValues: normalizeEnumValues(schema.enum),
      defaultValue: normalizeJsonValue(schema.default),
      deprecated: schema.deprecated === true,
      sensitive: hint?.sensitive === true,
      tags: [...(hint?.tags ?? [])].toSorted((left, right) => left.localeCompare(right)),
      label: hint?.label,
      help: hint?.help,
      hasChildren: schemaHasChildren(schema),
    });
  }

  const requiredKeys = new Set(schema.required ?? []);
  for (const key of Object.keys(schema.properties ?? {}).toSorted((left, right) =>
    left.localeCompare(right),
  )) {
    const child = asSchemaObject(schema.properties?.[key]);
    if (!child) {
      continue;
    }
    const childPath = normalizedPath ? `${normalizedPath}.${key}` : key;
    collectConfigDocBaselineEntries(
      child,
      uiHints,
      childPath,
      requiredKeys.has(key),
      entries,
      visited,
    );
  }

  if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
    const wildcard = asSchemaObject(schema.additionalProperties);
    if (wildcard) {
      const wildcardPath = normalizedPath ? `${normalizedPath}.*` : "*";
      collectConfigDocBaselineEntries(wildcard, uiHints, wildcardPath, false, entries, visited);
    }
  }

  if (Array.isArray(schema.items)) {
    for (const item of schema.items) {
      const child = asSchemaObject(item);
      if (!child) {
        continue;
      }
      const itemPath = normalizedPath ? `${normalizedPath}.*` : "*";
      collectConfigDocBaselineEntries(child, uiHints, itemPath, false, entries, visited);
    }
  } else if (schema.items && typeof schema.items === "object") {
    const itemSchema = asSchemaObject(schema.items);
    if (itemSchema) {
      const itemPath = normalizedPath ? `${normalizedPath}.*` : "*";
      collectConfigDocBaselineEntries(itemSchema, uiHints, itemPath, false, entries, visited);
    }
  }

  for (const branchSchema of [schema.oneOf, schema.anyOf, schema.allOf]) {
    for (const branch of branchSchema ?? []) {
      const child = asSchemaObject(branch);
      if (!child) {
        continue;
      }
      collectConfigDocBaselineEntries(child, uiHints, normalizedPath, required, entries, visited);
    }
  }

  return entries;
}

export function dedupeConfigDocBaselineEntries(
  entries: ConfigDocBaselineEntry[],
): ConfigDocBaselineEntry[] {
  const byPath = new Map<string, ConfigDocBaselineEntry>();
  for (const entry of entries) {
    const current = byPath.get(entry.path);
    byPath.set(entry.path, current ? mergeConfigDocBaselineEntry(current, entry) : entry);
  }
  return [...byPath.values()].toSorted((left, right) => left.path.localeCompare(right.path));
}

export async function buildConfigDocBaseline(): Promise<ConfigDocBaseline> {
  if (cachedConfigDocBaselinePromise) {
    return await cachedConfigDocBaselinePromise;
  }
  cachedConfigDocBaselinePromise = (async () => {
    const start = Date.now();
    logConfigDocBaselineDebug("build baseline start");
    const response = await loadBundledConfigSchemaResponse();
    const schemaRoot = asSchemaObject(response.schema);
    if (!schemaRoot) {
      throw new Error("config schema root is not an object");
    }
    const collectStart = Date.now();
    logConfigDocBaselineDebug("collect baseline entries start");
    const entries = dedupeConfigDocBaselineEntries(
      collectConfigDocBaselineEntries(schemaRoot, response.uiHints),
    );
    logConfigDocBaselineDebug(
      `collect baseline entries done count=${entries.length} elapsedMs=${Date.now() - collectStart}`,
    );
    logConfigDocBaselineDebug(`build baseline done elapsedMs=${Date.now() - start}`);
    return {
      generatedBy: GENERATED_BY,
      entries,
    };
  })();
  try {
    return await cachedConfigDocBaselinePromise;
  } catch (error) {
    cachedConfigDocBaselinePromise = null;
    throw error;
  }
}

export async function renderConfigDocBaselineStatefile(
  baseline?: ConfigDocBaseline | Promise<ConfigDocBaseline>,
): Promise<ConfigDocBaselineStatefileRender> {
  const start = Date.now();
  logConfigDocBaselineDebug("render statefile start");
  const resolvedBaseline = baseline ? await baseline : await buildConfigDocBaseline();
  const json = `${JSON.stringify(resolvedBaseline, null, 2)}\n`;
  const metadataLine = JSON.stringify({
    generatedBy: GENERATED_BY,
    recordType: "meta",
    totalPaths: resolvedBaseline.entries.length,
  });
  const entryLines = resolvedBaseline.entries.map((entry) =>
    JSON.stringify({
      recordType: "path",
      ...entry,
    }),
  );
  logConfigDocBaselineDebug(`render statefile done elapsedMs=${Date.now() - start}`);
  return {
    json,
    jsonl: `${[metadataLine, ...entryLines].join("\n")}\n`,
    baseline: resolvedBaseline,
  };
}

async function readIfExists(filePath: string): Promise<string | null> {
  try {
    return fsSync.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

async function writeIfChanged(filePath: string, next: string): Promise<boolean> {
  const current = await readIfExists(filePath);
  if (current === next) {
    return false;
  }
  fsSync.mkdirSync(path.dirname(filePath), { recursive: true });
  fsSync.writeFileSync(filePath, next, "utf8");
  return true;
}

export async function writeConfigDocBaselineStatefile(params?: {
  repoRoot?: string;
  check?: boolean;
  jsonPath?: string;
  statefilePath?: string;
  rendered?: ConfigDocBaselineStatefileRender | Promise<ConfigDocBaselineStatefileRender>;
}): Promise<ConfigDocBaselineStatefileWriteResult> {
  const start = Date.now();
  logConfigDocBaselineDebug("write statefile start");
  const repoRoot = params?.repoRoot ?? resolveRepoRoot();
  const jsonPath = path.resolve(repoRoot, params?.jsonPath ?? DEFAULT_JSON_OUTPUT);
  const statefilePath = path.resolve(repoRoot, params?.statefilePath ?? DEFAULT_STATEFILE_OUTPUT);
  const rendered = params?.rendered
    ? await params.rendered
    : await renderConfigDocBaselineStatefile();
  logConfigDocBaselineDebug(`render statefile done elapsedMs=${Date.now() - start}`);
  logConfigDocBaselineDebug(`read current json start ${jsonPath}`);
  const currentJson = await readIfExists(jsonPath);
  logConfigDocBaselineDebug(`read current json done elapsedMs=${Date.now() - start}`);
  logConfigDocBaselineDebug(`read current statefile start ${statefilePath}`);
  const currentStatefile = await readIfExists(statefilePath);
  logConfigDocBaselineDebug(`read current statefile done elapsedMs=${Date.now() - start}`);
  const changed = currentJson !== rendered.json || currentStatefile !== rendered.jsonl;
  logConfigDocBaselineDebug(
    `compare statefile done changed=${changed} elapsedMs=${Date.now() - start}`,
  );

  if (params?.check) {
    return {
      changed,
      wrote: false,
      jsonPath,
      statefilePath,
    };
  }

  const wroteJson = await writeIfChanged(jsonPath, rendered.json);
  const wroteStatefile = await writeIfChanged(statefilePath, rendered.jsonl);
  return {
    changed,
    wrote: wroteJson || wroteStatefile,
    jsonPath,
    statefilePath,
  };
}

export function normalizeConfigDocBaselineHelpPath(pathValue: string): string {
  return normalizeBaselinePath(pathValue);
}

export function getNormalizedFieldHelp(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(FIELD_HELP)
      .map(([configPath, help]) => [normalizeBaselinePath(configPath), help] as const)
      .toSorted(([left], [right]) => left.localeCompare(right)),
  );
}
