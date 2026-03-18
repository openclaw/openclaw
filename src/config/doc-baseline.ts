import { spawnSync } from "node:child_process";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ChannelPlugin } from "../channels/plugins/index.js";
import { resolveOpenClawPackageRootSync } from "../infra/openclaw-root.js";
import { loadPluginManifestRegistry } from "../plugins/manifest-registry.js";
import { FIELD_HELP } from "./schema.help.js";
import { buildConfigSchema, type ConfigSchemaResponse } from "./schema.js";
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

type PackageChannelMetadata = {
  id: string;
  label: string;
  blurb?: string;
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

function loadPackageChannelMetadata(rootDir: string): PackageChannelMetadata | null {
  try {
    const packageJson = JSON.parse(
      fsSync.readFileSync(path.join(rootDir, "package.json"), "utf8"),
    ) as {
      openclaw?: {
        channel?: {
          id?: unknown;
          label?: unknown;
          blurb?: unknown;
        };
      };
    };
    const channel = packageJson.openclaw?.channel;
    if (!channel) {
      return null;
    }
    const id = typeof channel.id === "string" ? channel.id.trim() : "";
    const label = typeof channel.label === "string" ? channel.label.trim() : "";
    const blurb = typeof channel.blurb === "string" ? channel.blurb.trim() : "";
    if (!id || !label) {
      return null;
    }
    return {
      id,
      label,
      ...(blurb ? { blurb } : {}),
    };
  } catch {
    return null;
  }
}

function isChannelPlugin(value: unknown): value is ChannelPlugin {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as { id?: unknown; meta?: unknown; capabilities?: unknown };
  return typeof candidate.id === "string" && typeof candidate.meta === "object";
}

function resolveSetupChannelPlugin(value: unknown): ChannelPlugin | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as { plugin?: unknown };
  return isChannelPlugin(candidate.plugin) ? candidate.plugin : null;
}

async function importChannelPluginModule(rootDir: string): Promise<ChannelPlugin> {
  logConfigDocBaselineDebug(`resolve channel module ${rootDir}`);
  const modulePath = resolveFirstExistingPath([
    path.join(rootDir, "setup-entry.ts"),
    path.join(rootDir, "setup-entry.js"),
    path.join(rootDir, "setup-entry.mts"),
    path.join(rootDir, "setup-entry.mjs"),
    path.join(rootDir, "src", "channel.ts"),
    path.join(rootDir, "src", "channel.js"),
    path.join(rootDir, "src", "plugin.ts"),
    path.join(rootDir, "src", "plugin.js"),
    path.join(rootDir, "src", "index.ts"),
    path.join(rootDir, "src", "index.js"),
    path.join(rootDir, "src", "channel.mts"),
    path.join(rootDir, "src", "channel.mjs"),
    path.join(rootDir, "src", "plugin.mts"),
    path.join(rootDir, "src", "plugin.mjs"),
  ]);
  if (!modulePath) {
    throw new Error(`channel source not found under ${rootDir}`);
  }

  logConfigDocBaselineDebug(`import channel module ${modulePath}`);
  const imported = (await import(modulePath)) as Record<string, unknown>;
  logConfigDocBaselineDebug(`imported channel module ${modulePath}`);
  for (const value of Object.values(imported)) {
    if (isChannelPlugin(value)) {
      logConfigDocBaselineDebug(`resolved channel export ${modulePath}`);
      return value;
    }
    const setupPlugin = resolveSetupChannelPlugin(value);
    if (setupPlugin) {
      logConfigDocBaselineDebug(`resolved setup channel export ${modulePath}`);
      return setupPlugin;
    }
    if (typeof value === "function" && value.length === 0) {
      const resolved = value();
      if (isChannelPlugin(resolved)) {
        logConfigDocBaselineDebug(`resolved channel factory ${modulePath}`);
        return resolved;
      }
    }
  }

  throw new Error(`channel plugin export not found in ${modulePath}`);
}

async function importChannelSurfaceMetadata(
  rootDir: string,
  repoRoot: string,
  env: NodeJS.ProcessEnv,
): Promise<ChannelSurfaceMetadata | null> {
  logConfigDocBaselineDebug(`resolve channel config surface ${rootDir}`);
  const packageMetadata = loadPackageChannelMetadata(rootDir);
  if (!packageMetadata) {
    logConfigDocBaselineDebug(`missing package channel metadata ${rootDir}`);
    return null;
  }

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
    logConfigDocBaselineDebug(`spawn channel config schema subprocess ${modulePath}`);
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        path.join(repoRoot, "scripts", "load-channel-config-surface.ts"),
        modulePath,
      ],
      {
        cwd: repoRoot,
        encoding: "utf8",
        env,
        timeout: 15_000,
        maxBuffer: 10 * 1024 * 1024,
      },
    );
    if (result.status !== 0 || result.error) {
      throw result.error ?? new Error(result.stderr || `child exited with status ${result.status}`);
    }
    logConfigDocBaselineDebug(`completed channel config schema subprocess ${modulePath}`);
    const configSchema = JSON.parse(result.stdout) as {
      schema: Record<string, unknown>;
      uiHints?: ConfigSchemaResponse["uiHints"];
    };
    return {
      id: packageMetadata.id,
      label: packageMetadata.label,
      description: packageMetadata.blurb,
      configSchema: configSchema.schema,
      configUiHints: configSchema.uiHints,
    };
  } catch (error) {
    logConfigDocBaselineDebug(
      `channel config schema subprocess failed for ${modulePath}: ${String(error)}`,
    );
    return null;
  }
}

async function loadChannelSurfaceMetadata(
  rootDir: string,
  repoRoot: string,
  env: NodeJS.ProcessEnv,
): Promise<ChannelSurfaceMetadata> {
  logConfigDocBaselineDebug(`load channel surface ${rootDir}`);
  const configSurface = await importChannelSurfaceMetadata(rootDir, repoRoot, env);
  if (configSurface) {
    logConfigDocBaselineDebug(`resolved channel config surface ${rootDir}`);
    return configSurface;
  }

  logConfigDocBaselineDebug(`fallback to channel plugin import ${rootDir}`);
  const plugin = await importChannelPluginModule(rootDir);
  return {
    id: plugin.id,
    label: plugin.meta.label,
    description: plugin.meta.blurb,
    configSchema: plugin.configSchema?.schema,
    configUiHints: plugin.configSchema?.uiHints,
  };
}

async function loadBundledConfigSchemaResponse(): Promise<ConfigSchemaResponse> {
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
  logConfigDocBaselineDebug(`loaded ${manifestRegistry.plugins.length} bundled plugin manifests`);
  const bundledChannelPlugins = manifestRegistry.plugins.filter(
    (plugin) => plugin.origin === "bundled" && plugin.channels.length > 0,
  );
  const loadChannelsSequentiallyForDebug = process.env.OPENCLAW_CONFIG_DOC_BASELINE_DEBUG === "1";
  const channelPlugins = loadChannelsSequentiallyForDebug
    ? await bundledChannelPlugins.reduce<Promise<ChannelSurfaceMetadata[]>>(
        async (promise, plugin) => {
          const loaded = await promise;
          loaded.push(await loadChannelSurfaceMetadata(plugin.rootDir, repoRoot, env));
          return loaded;
        },
        Promise.resolve([]),
      )
    : await Promise.all(
        bundledChannelPlugins.map(
          async (plugin) => await loadChannelSurfaceMetadata(plugin.rootDir, repoRoot, env),
        ),
      );
  logConfigDocBaselineDebug(`imported ${channelPlugins.length} bundled channel plugins`);

  return buildConfigSchema({
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
}

export async function renderConfigDocBaselineStatefile(
  baseline?: ConfigDocBaseline,
): Promise<ConfigDocBaselineStatefileRender> {
  const start = Date.now();
  logConfigDocBaselineDebug("render statefile start");
  const resolvedBaseline = baseline ?? (await buildConfigDocBaseline());
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
}): Promise<ConfigDocBaselineStatefileWriteResult> {
  const start = Date.now();
  logConfigDocBaselineDebug("write statefile start");
  const repoRoot = params?.repoRoot ?? resolveRepoRoot();
  const jsonPath = path.resolve(repoRoot, params?.jsonPath ?? DEFAULT_JSON_OUTPUT);
  const statefilePath = path.resolve(repoRoot, params?.statefilePath ?? DEFAULT_STATEFILE_OUTPUT);
  const rendered = await renderConfigDocBaselineStatefile();
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
