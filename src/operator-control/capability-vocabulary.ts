import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { resolveOperatorReferenceSourcePath } from "./reference-paths.js";

type RawCapabilityVocabulary = {
  capabilities?: Array<{
    id?: unknown;
    aliases?: unknown;
  }>;
};

type CompiledCapabilityVocabulary = {
  canonical: Set<string>;
  aliasToCanonical: Map<string, string>;
};

type VocabularySourceParams = {
  sourcePath?: string;
};

const EMPTY_VOCABULARY: CompiledCapabilityVocabulary = {
  canonical: new Set<string>(),
  aliasToCanonical: new Map<string, string>(),
};

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);
}

function resolveCapabilityVocabularySourcePath(params?: VocabularySourceParams): string {
  return resolveOperatorReferenceSourcePath("operator-capability-vocabulary.yaml", params);
}

let cachedVocabulary: {
  sourcePath: string;
  mtimeMs: number;
  compiled: CompiledCapabilityVocabulary;
} | null = null;

export function loadOperatorCapabilityVocabulary(
  params?: VocabularySourceParams,
): CompiledCapabilityVocabulary {
  const sourcePath = resolveCapabilityVocabularySourcePath(params);
  let stats: fs.Stats;
  try {
    stats = fs.statSync(sourcePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return EMPTY_VOCABULARY;
    }
    throw error;
  }
  if (
    cachedVocabulary &&
    cachedVocabulary.sourcePath === sourcePath &&
    cachedVocabulary.mtimeMs === stats.mtimeMs
  ) {
    return cachedVocabulary.compiled;
  }

  const raw = fs.readFileSync(sourcePath, "utf8");
  const parsed = (YAML.parse(raw, { schema: "core" }) ?? {}) as RawCapabilityVocabulary;
  const canonical = new Set<string>();
  const aliasToCanonical = new Map<string, string>();

  for (const entry of parsed.capabilities ?? []) {
    const id = typeof entry.id === "string" ? normalize(entry.id) : "";
    if (!id) {
      continue;
    }
    canonical.add(id);
    aliasToCanonical.set(id, id);
    for (const alias of asStringArray(entry.aliases)) {
      aliasToCanonical.set(normalize(alias), id);
    }
  }

  const compiled = { canonical, aliasToCanonical };
  cachedVocabulary = {
    sourcePath,
    mtimeMs: stats.mtimeMs,
    compiled,
  };
  return compiled;
}

export function normalizeOperatorCapability(
  capability: string,
  params?: VocabularySourceParams,
): string {
  const needle = normalize(capability);
  const vocabulary = loadOperatorCapabilityVocabulary(params);
  return vocabulary.aliasToCanonical.get(needle) ?? needle;
}

export function isCanonicalOperatorCapability(
  capability: string,
  params?: VocabularySourceParams,
): boolean {
  const vocabulary = loadOperatorCapabilityVocabulary(params);
  return vocabulary.canonical.has(normalize(capability));
}

export function getCanonicalOperatorCapabilities(params?: VocabularySourceParams): string[] {
  return [...loadOperatorCapabilityVocabulary(params).canonical].toSorted();
}

export function getOperatorCapabilityVocabularyStats(params?: VocabularySourceParams): {
  canonicalCount: number;
  aliasCount: number;
} {
  const vocabulary = loadOperatorCapabilityVocabulary(params);
  return {
    canonicalCount: vocabulary.canonical.size,
    aliasCount: vocabulary.aliasToCanonical.size - vocabulary.canonical.size,
  };
}

export function getOperatorCapabilityVocabularySourcePath(): string {
  return path.resolve(resolveCapabilityVocabularySourcePath());
}
