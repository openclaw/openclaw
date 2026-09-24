// Builds documentation baselines from config schema metadata.
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { replaceFileAtomicSync } from "@openclaw/fs-safe/atomic";
import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { sortUniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { resolveOpenClawPackageRootSync } from "../infra/openclaw-root.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import { resolveRepoBundledPluginEnv } from "./repo-bundled-plugin-env.js";
import type { ConfigSchemaResponse } from "./schema.js";
import {
  asSchemaObject,
  countMatchingHintWildcards,
  type ConfigJsonSchemaObject as JsonSchemaObject,
  schemaHasChildren,
} from "./schema.shared.js";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

type ConfigDocBaselineKind = "core" | "channel" | "plugin";

type ConfigDocBaselineCounts = Record<ConfigDocBaselineKind, number>;

type ConfigDocBaselineCountViolation = {
  kind: ConfigDocBaselineKind;
  current: number;
  budget: number;
  message: string;
};

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

type ConfigDocBaseline = {
  generatedBy: "scripts/generate-config-doc-baseline.ts";
  coreEntries: ConfigDocBaselineEntry[];
  channelEntries: ConfigDocBaselineEntry[];
  pluginEntries: ConfigDocBaselineEntry[];
};

type ConfigDocBaselineKindBaseline = {
  generatedBy: "scripts/generate-config-doc-baseline.ts";
  kind: ConfigDocBaselineKind;
  entries: ConfigDocBaselineEntry[];
};

type ConfigDocBaselineArtifacts = {
  combined: string;
  core: string;
  channel: string;
  plugin: string;
};

type ConfigDocBaselineArtifactsRender = {
  baseline: ConfigDocBaseline;
  json: ConfigDocBaselineArtifacts;
};

type ConfigDocBaselinePathOptions = Partial<
  Record<`${keyof ConfigDocBaselineArtifacts}Path`, string>
>;

type ConfigDocBaselineArtifactsWriteResult = {
  changed: boolean;
  hashChanged: boolean;
  wrote: boolean;
  jsonPaths: ConfigDocBaselineArtifacts;
  hashPath: string;
  countsPath: string;
  countViolations: ConfigDocBaselineCountViolation[];
  countBudgetError?: string;
};

const GENERATED_BY = "scripts/generate-config-doc-baseline.ts" as const;
const DEFAULT_COMBINED_OUTPUT = "docs/.generated/config-baseline.json";
const DEFAULT_CORE_OUTPUT = "docs/.generated/config-baseline.core.json";
const DEFAULT_CHANNEL_OUTPUT = "docs/.generated/config-baseline.channel.json";
const DEFAULT_PLUGIN_OUTPUT = "docs/.generated/config-baseline.plugin.json";
const DEFAULT_HASH_OUTPUT = "docs/.generated/config-baseline.sha256";
const DEFAULT_COUNTS_OUTPUT = "docs/.generated/config-baseline.counts.json";
// A successful schema snapshot is process-stable; failures clear below so tooling can retry.
let cachedConfigDocBaselinePromise: Promise<ConfigDocBaseline> | null = null;
const uiHintIndexCache = new WeakMap<
  ConfigSchemaResponse["uiHints"],
  Map<number, Array<{ parts: string[]; hint: ConfigSchemaResponse["uiHints"][string] }>>
>();
const schemaHasChildrenCache = new WeakMap<JsonSchemaObject, boolean>();

function compareBaselineStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
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

const loadDocBaselineRuntime = createLazyRuntimeModule(() => import("./doc-baseline.runtime.js"));

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
    return value
      .map((entry) => normalizeJsonValue(entry))
      .filter((entry): entry is JsonValue => entry !== undefined);
  }
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .toSorted(([left], [right]) => compareBaselineStrings(left, right))
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

function splitHintLookupPath(pathResult: string): string[] {
  const normalized = normalizeBaselinePath(pathResult);
  return normalized ? normalized.split(".").filter(Boolean) : [];
}

function resolveUiHintMatch(
  uiHints: ConfigSchemaResponse["uiHints"],
  pathLocal: string,
): ConfigSchemaResponse["uiHints"][string] | undefined {
  const targetParts = splitHintLookupPath(pathLocal);
  if (targetParts.length === 0) {
    return undefined;
  }

  let index = uiHintIndexCache.get(uiHints);
  if (!index) {
    index = new Map();
    for (const [hintPath, hint] of Object.entries(uiHints)) {
      const parts = splitHintLookupPath(hintPath);
      const group = index.get(parts.length) ?? [];
      group.push({ parts, hint });
      index.set(parts.length, group);
    }
    uiHintIndexCache.set(uiHints, index);
  }

  const candidates = index.get(targetParts.length);
  if (!candidates) {
    return undefined;
  }

  let bestMatch:
    | {
        hint: ConfigSchemaResponse["uiHints"][string];
        wildcardCount: number;
      }
    | undefined;

  for (const candidate of candidates) {
    const wildcardCount = countMatchingHintWildcards(candidate.parts, targetParts);
    if (wildcardCount === undefined) {
      continue;
    }
    if (!bestMatch || wildcardCount < bestMatch.wildcardCount) {
      bestMatch = { hint: candidate.hint, wildcardCount };
      if (wildcardCount === 0) {
        break;
      }
    }
  }

  return bestMatch?.hint;
}

function resolveSchemaHasChildren(schema: JsonSchemaObject): boolean {
  const cached = schemaHasChildrenCache.get(schema);
  if (cached !== undefined) {
    return cached;
  }
  const next = schemaHasChildren(schema);
  schemaHasChildrenCache.set(schema, next);
  return next;
}

function normalizeTypeValue(value: string | string[] | undefined): string | string[] | undefined {
  if (!value) {
    return undefined;
  }
  if (Array.isArray(value)) {
    const normalized = sortUniqueStrings(value);
    return normalized.length === 1 ? normalized[0] : normalized;
  }
  return value;
}

function mergeTypeValues(
  left: string | string[] | undefined,
  right: string | string[] | undefined,
): string | string[] | undefined {
  return normalizeTypeValue([left, right].flatMap((value) => value || []));
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
    .toSorted(([leftKey], [rightKey]) => compareBaselineStrings(leftKey, rightKey))
    .map(([, value]) => value);
}

function mergeConfigDocBaselineEntry(
  current: ConfigDocBaselineEntry,
  next: ConfigDocBaselineEntry,
): ConfigDocBaselineEntry {
  const defaultValue =
    JSON.stringify(current.defaultValue) === JSON.stringify(next.defaultValue)
      ? current.defaultValue
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
    tags: sortUniqueStrings([...current.tags, ...next.tags]),
    label: current.label ?? next.label,
    help: current.help ?? next.help,
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

async function loadBundledConfigSchemaResponse(): Promise<ConfigSchemaResponse> {
  const repoRoot = resolveRepoRoot();
  const runtime = await loadDocBaselineRuntime();
  const env = resolveRepoBundledPluginEnv(path.join(repoRoot, "extensions"));

  const manifestRegistry = runtime.loadPluginManifestRegistry({
    env,
    config: {},
    bundledChannelConfigCollector: runtime.collectBundledChannelConfigs,
  });
  const bundledRegistry = {
    ...manifestRegistry,
    plugins: manifestRegistry.plugins.filter((plugin) => plugin.origin === "bundled"),
  };
  const channelPlugins = runtime.collectChannelSchemaMetadata(bundledRegistry);

  return runtime.buildConfigSchema({
    plugins: runtime.collectPluginSchemaMetadata(bundledRegistry),
    channels: channelPlugins,
  });
}

function collectConfigDocBaselineEntries(
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
      tags: [...(hint?.tags ?? [])].toSorted(compareBaselineStrings),
      label: hint?.label,
      help: hint?.help,
      hasChildren: resolveSchemaHasChildren(schema),
    });
  }

  const requiredKeys = new Set(schema.required ?? []);
  for (const key of Object.keys(schema.properties ?? {}).toSorted(compareBaselineStrings)) {
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

  const visitWildcard = (value: unknown) => {
    const child = asSchemaObject(value);
    if (child) {
      const wildcardPath = normalizedPath ? `${normalizedPath}.*` : "*";
      collectConfigDocBaselineEntries(child, uiHints, wildcardPath, false, entries, visited);
    }
  };

  if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
    visitWildcard(schema.additionalProperties);
  }

  if (Array.isArray(schema.items)) {
    for (const item of schema.items) {
      visitWildcard(item);
    }
  } else if (schema.items && typeof schema.items === "object") {
    visitWildcard(schema.items);
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

function dedupeConfigDocBaselineEntries(
  entries: ConfigDocBaselineEntry[],
): ConfigDocBaselineEntry[] {
  const byPath = new Map<string, ConfigDocBaselineEntry>();
  for (const entry of entries) {
    const current = byPath.get(entry.path);
    byPath.set(entry.path, current ? mergeConfigDocBaselineEntry(current, entry) : entry);
  }
  return [...byPath.values()].toSorted((left, right) =>
    compareBaselineStrings(left.path, right.path),
  );
}

function splitConfigDocBaselineEntries(entries: ConfigDocBaselineEntry[]): {
  coreEntries: ConfigDocBaselineEntry[];
  channelEntries: ConfigDocBaselineEntry[];
  pluginEntries: ConfigDocBaselineEntry[];
} {
  const byKind: Record<ConfigDocBaselineKind, ConfigDocBaselineEntry[]> = {
    core: [],
    channel: [],
    plugin: [],
  };
  for (const entry of entries) {
    byKind[entry.kind].push(entry);
  }
  return {
    coreEntries: byKind.core,
    channelEntries: byKind.channel,
    pluginEntries: byKind.plugin,
  };
}

async function buildConfigDocBaseline(): Promise<ConfigDocBaseline> {
  if (cachedConfigDocBaselinePromise) {
    return await cachedConfigDocBaselinePromise;
  }
  cachedConfigDocBaselinePromise = (async () => {
    const response = await loadBundledConfigSchemaResponse();
    const schemaRoot = asSchemaObject(response.schema);
    if (!schemaRoot) {
      throw new Error("config schema root is not an object");
    }
    const entries = dedupeConfigDocBaselineEntries(
      collectConfigDocBaselineEntries(schemaRoot, response.uiHints),
    );
    const { coreEntries, channelEntries, pluginEntries } = splitConfigDocBaselineEntries(entries);
    return {
      generatedBy: GENERATED_BY,
      coreEntries,
      channelEntries,
      pluginEntries,
    };
  })();
  try {
    return await cachedConfigDocBaselinePromise;
  } catch (error) {
    cachedConfigDocBaselinePromise = null;
    throw error;
  }
}

function renderKindBaseline(
  kind: ConfigDocBaselineKind,
  entries: ConfigDocBaselineEntry[],
): string {
  const baseline: ConfigDocBaselineKindBaseline = {
    generatedBy: GENERATED_BY,
    kind,
    entries,
  };
  return `${JSON.stringify(baseline, null, 2)}\n`;
}

export async function renderConfigDocBaselineArtifacts(
  baseline?: ConfigDocBaseline | Promise<ConfigDocBaseline>,
): Promise<ConfigDocBaselineArtifactsRender> {
  const resolvedBaseline = baseline ? await baseline : await buildConfigDocBaseline();
  return {
    json: {
      combined: `${JSON.stringify(resolvedBaseline, null, 2)}\n`,
      core: renderKindBaseline("core", resolvedBaseline.coreEntries),
      channel: renderKindBaseline("channel", resolvedBaseline.channelEntries),
      plugin: renderKindBaseline("plugin", resolvedBaseline.pluginEntries),
    },
    baseline: resolvedBaseline,
  };
}

function readFileIfExists(filePath: string): string | null {
  try {
    return fsSync.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function writeFileAtomic(filePath: string, content: string): void {
  replaceFileAtomicSync({
    filePath,
    content,
    dirMode: 0o755,
    mode: 0o644,
    tempPrefix: path.basename(filePath),
  });
}

/** Build the sha256 hash file content for all config baseline artifacts. */
function computeConfigBaselineHashFileContent(json: ConfigDocBaselineArtifacts): string {
  const lines = [
    `${sha256Hex(json.combined)}  config-baseline.json`,
    `${sha256Hex(json.core)}  config-baseline.core.json`,
    `${sha256Hex(json.channel)}  config-baseline.channel.json`,
    `${sha256Hex(json.plugin)}  config-baseline.plugin.json`,
  ];
  return `${lines.join("\n")}\n`;
}

function computeConfigBaselineCounts(baseline: ConfigDocBaseline): ConfigDocBaselineCounts {
  return {
    core: baseline.coreEntries.length,
    channel: baseline.channelEntries.length,
    plugin: baseline.pluginEntries.length,
  };
}

function parseConfigBaselineCounts(content: string | null): ConfigDocBaselineCounts {
  if (content === null) {
    throw new Error("count budget file is missing");
  }
  const record = asNullableRecord(JSON.parse(content));
  if (!record) {
    throw new Error("count budget must be a JSON object");
  }
  for (const kind of ["core", "channel", "plugin"] as const) {
    if (!Number.isInteger(record[kind]) || (record[kind] as number) < 0) {
      throw new Error(`${kind} budget must be a non-negative integer`);
    }
  }
  return {
    core: record.core as number,
    channel: record.channel as number,
    plugin: record.plugin as number,
  };
}

function collectConfigBaselineCountViolations(
  current: ConfigDocBaselineCounts,
  budget: ConfigDocBaselineCounts,
): ConfigDocBaselineCountViolation[] {
  const violations: ConfigDocBaselineCountViolation[] = [];
  for (const kind of ["core", "channel", "plugin"] as const) {
    if (current[kind] === budget[kind]) {
      continue;
    }
    const message =
      current[kind] > budget[kind]
        ? `${kind}: current ${current[kind]} > budget ${budget[kind]}; config surface grew; either remove config elsewhere or consciously raise the budget in docs/.generated/config-baseline.counts.json in this PR and justify it in the PR body. See the AGENTS.md config-surface bar.`
        : `${kind}: current ${current[kind]} < budget ${budget[kind]}; budget is stale; run pnpm config:docs:gen to ratchet it down.`;
    violations.push({
      kind,
      current: current[kind],
      budget: budget[kind],
      message,
    });
  }
  return violations;
}

function resolveBaselineArtifactPaths(
  repoRoot: string,
  params?: ConfigDocBaselinePathOptions,
): ConfigDocBaselineArtifacts {
  return {
    combined: path.resolve(repoRoot, params?.combinedPath ?? DEFAULT_COMBINED_OUTPUT),
    core: path.resolve(repoRoot, params?.corePath ?? DEFAULT_CORE_OUTPUT),
    channel: path.resolve(repoRoot, params?.channelPath ?? DEFAULT_CHANNEL_OUTPUT),
    plugin: path.resolve(repoRoot, params?.pluginPath ?? DEFAULT_PLUGIN_OUTPUT),
  };
}

export async function writeConfigDocBaselineArtifacts(
  params?: ConfigDocBaselinePathOptions & {
    repoRoot?: string;
    check?: boolean;
    hashPath?: string;
    countsPath?: string;
    rendered?: ConfigDocBaselineArtifactsRender | Promise<ConfigDocBaselineArtifactsRender>;
  },
): Promise<ConfigDocBaselineArtifactsWriteResult> {
  const repoRoot = params?.repoRoot ?? resolveRepoRoot();
  const jsonPaths = resolveBaselineArtifactPaths(repoRoot, params);
  const hashPath = path.resolve(repoRoot, params?.hashPath ?? DEFAULT_HASH_OUTPUT);
  const countsPath = path.resolve(repoRoot, params?.countsPath ?? DEFAULT_COUNTS_OUTPUT);
  const rendered = params?.rendered
    ? await params.rendered
    : await renderConfigDocBaselineArtifacts();

  const nextHashContent = computeConfigBaselineHashFileContent(rendered.json);
  const counts = computeConfigBaselineCounts(rendered.baseline);
  const nextCountsContent = `${JSON.stringify(counts, null, 2)}\n`;
  const currentHashContent = readFileIfExists(hashPath);
  const hashChanged = currentHashContent !== nextHashContent;
  let countBudgetError: string | undefined;
  let countViolations: ConfigDocBaselineCountViolation[] = [];
  try {
    countViolations = collectConfigBaselineCountViolations(
      counts,
      parseConfigBaselineCounts(readFileIfExists(countsPath)),
    );
  } catch (error) {
    countBudgetError = error instanceof Error ? error.message : String(error);
  }
  const changed = hashChanged || countBudgetError !== undefined || countViolations.length > 0;

  if (params?.check) {
    return {
      changed,
      hashChanged,
      wrote: false,
      jsonPaths,
      hashPath,
      countsPath,
      countViolations,
      ...(countBudgetError ? { countBudgetError } : {}),
    };
  }

  // Write tracked drift-detection artifacts.
  writeFileAtomic(hashPath, nextHashContent);
  writeFileAtomic(countsPath, nextCountsContent);

  // Write full JSON artifacts locally (gitignored, useful for inspection)
  for (const key of Object.keys(jsonPaths) as Array<keyof ConfigDocBaselineArtifacts>) {
    writeFileAtomic(jsonPaths[key], rendered.json[key]);
  }

  return {
    changed,
    hashChanged,
    wrote: true,
    jsonPaths,
    hashPath,
    countsPath,
    countViolations: [],
  };
}
