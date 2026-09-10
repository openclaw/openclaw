import { isDeepStrictEqual } from "node:util";
import { getRecord } from "../../../config/legacy.shared.js";
import { isBlockedObjectKey } from "../../../infra/prototype-keys.js";
import {
  normalizeKnownModelRef,
  normalizeProviderCatalogModelId,
} from "./legacy-model-ref-normalization.js";

export function hasOwnDefinedProperty(record: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(record, key) && record[key] !== undefined;
}

const MODEL_REF_STRING_KEYS = new Set([
  "model",
  "primary",
  "summaryModel",
  "imageModel",
  "utilityModel",
  "voiceModel",
  "imageGenerationModel",
  "musicGenerationModel",
  "pdfModel",
  "videoGenerationModel",
  "preferredModel",
]);
const MODEL_REF_ARRAY_KEYS = new Set([
  "fallback",
  "fallbacks",
  "allowedModels",
  "modelFallbacks",
  "imageModelFallbacks",
]);
const MODEL_REF_MAP_KEYS = new Set(["models"]);
function pathKey(path: string): string {
  return path.slice(path.lastIndexOf(".") + 1);
}

function isChannelModelOverridePath(path: string): boolean {
  return path.includes(".modelByChannel.");
}

function isModelPolicyAllowPath(path: string): boolean {
  return path.endsWith(".modelPolicy.allow");
}

function isMediaModelPath(path: string): boolean {
  return ["image", "video", "music"].includes(pathKey(path)) && path.includes(".mediaModels.");
}

function isProviderCatalogsPath(path: string): boolean {
  return path === ".providers" || path.endsWith(".models.providers");
}

function scanProviderCatalogModelIds(providers: Record<string, unknown>): boolean {
  return Object.entries(providers).some(([providerId, providerValue]) => {
    const models = getRecord(providerValue)?.models;
    return (
      Array.isArray(models) &&
      models.some((model) => {
        const modelId = getRecord(model)?.id;
        return (
          typeof modelId === "string" &&
          normalizeProviderCatalogModelId(providerId, modelId) !== modelId
        );
      })
    );
  });
}

export function scanKnownModelRefs(value: unknown, key?: string, path = ""): boolean {
  if (typeof value === "string") {
    return Boolean(
      key &&
      (MODEL_REF_STRING_KEYS.has(key) ||
        isChannelModelOverridePath(path) ||
        isMediaModelPath(path)) &&
      normalizeKnownModelRef(value),
    );
  }
  if (Array.isArray(value)) {
    return value.some((entry, index) =>
      typeof entry === "string" &&
      key &&
      (MODEL_REF_ARRAY_KEYS.has(key) || isModelPolicyAllowPath(path))
        ? Boolean(normalizeKnownModelRef(entry))
        : scanKnownModelRefs(entry, undefined, `${path}.${index}`),
    );
  }
  const record = getRecord(value);
  if (!record) {
    return false;
  }
  const provider = typeof record.provider === "string" ? record.provider : undefined;
  const model = typeof record.model === "string" ? record.model : undefined;
  const providerModelPair = provider !== undefined && model !== undefined;
  if (providerModelPair && normalizeKnownModelRef(`${provider}/${model}`)) {
    return true;
  }
  if (isProviderCatalogsPath(path) && scanProviderCatalogModelIds(record)) {
    return true;
  }
  if (key && MODEL_REF_MAP_KEYS.has(key)) {
    return Object.keys(record).some((entryKey) => Boolean(normalizeKnownModelRef(entryKey)));
  }
  return Object.entries(record).some(
    ([childKey, child]) =>
      !(providerModelPair && childKey === "model") &&
      scanKnownModelRefs(child, childKey, `${path}.${childKey}`),
  );
}

type ModelRefNormalizer = (value: string) => string | null;

function rewriteModelRefString(
  value: string,
  path: string,
  changes: string[],
  normalize: ModelRefNormalizer,
): string {
  const upgraded = normalize(value);
  if (upgraded === null || upgraded === value) {
    return value;
  }
  changes.push(`Upgraded ${path} from ${JSON.stringify(value)} to ${JSON.stringify(upgraded)}.`);
  return upgraded;
}

export function setRecordEntry(record: Record<string, unknown>, key: string, value: unknown): void {
  // Config dictionaries can contain hostile keys; define own properties so
  // rebuilding or copying them never invokes Object.prototype setters.
  Object.defineProperty(record, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

function sanitizeModelRefMapEntry(value: unknown): unknown {
  // Collisions combine both entries before recursive ref rewriting, so blocked
  // keys must be removed at every depth on both sides of the merge.
  if (Array.isArray(value)) {
    return value.map(sanitizeModelRefMapEntry);
  }
  const record = getRecord(value);
  if (!record) {
    return value;
  }
  const sanitized: Record<string, unknown> = {};
  for (const [field, child] of Object.entries(record)) {
    if (!isBlockedObjectKey(field)) {
      setRecordEntry(sanitized, field, sanitizeModelRefMapEntry(child));
    }
  }
  return sanitized;
}

function modelRefValuesAreEqual(
  existing: unknown,
  incoming: unknown,
  path: string,
  normalize: ModelRefNormalizer,
): boolean {
  if (isDeepStrictEqual(existing, incoming)) {
    return true;
  }
  const normalizedExisting = rewriteModelRefs(existing, path, [], normalize).value;
  const normalizedIncoming = rewriteModelRefs(incoming, path, [], normalize).value;
  return isDeepStrictEqual(normalizedExisting, normalizedIncoming);
}

export function mergeModelRefMapEntries(
  existing: unknown,
  incoming: unknown,
  path: string,
  normalize: ModelRefNormalizer = normalizeKnownModelRef,
): { value: unknown; conflicts: string[] } {
  const existingRecord = getRecord(existing);
  const incomingRecord = getRecord(incoming);
  if (!existingRecord || !incomingRecord) {
    return {
      value: sanitizeModelRefMapEntry(existing),
      conflicts: modelRefValuesAreEqual(existing, incoming, path, normalize) ? [] : ["value"],
    };
  }
  const merged = sanitizeModelRefMapEntry(existingRecord) as Record<string, unknown>;
  const conflicts: string[] = [];
  for (const [field, incomingValue] of Object.entries(incomingRecord)) {
    if (incomingValue === undefined || isBlockedObjectKey(field)) {
      continue;
    }
    if (!hasOwnDefinedProperty(existingRecord, field)) {
      setRecordEntry(merged, field, sanitizeModelRefMapEntry(incomingValue));
      continue;
    }
    const existingValue = existingRecord[field];
    const fieldPath = `${path}.${field}`;
    if (modelRefValuesAreEqual(existingValue, incomingValue, fieldPath, normalize)) {
      continue;
    }
    const existingField = getRecord(existingValue);
    const incomingField = getRecord(incomingValue);
    if (existingField && incomingField) {
      const nested = mergeModelRefMapEntries(existingField, incomingField, fieldPath, normalize);
      setRecordEntry(merged, field, nested.value);
      conflicts.push(...nested.conflicts.map((c) => `${field}.${c}`));
      continue;
    }
    conflicts.push(field);
  }
  return { value: merged, conflicts };
}

function rewriteModelRefMapKeys(
  record: Record<string, unknown>,
  path: string,
  changes: string[],
  normalize: ModelRefNormalizer,
): { value: Record<string, unknown>; changed: boolean } {
  let changed = false;
  const next: Record<string, unknown> = {};
  const consumedCanonicalKeys = new Set<string>();
  for (const [key, child] of Object.entries(record)) {
    const upgradedKey = normalize(key);
    const nextKey = upgradedKey ?? key;
    if (!upgradedKey && consumedCanonicalKeys.has(key)) {
      continue;
    }
    if (upgradedKey) {
      changes.push(
        `Upgraded ${path} key from ${JSON.stringify(key)} to ${JSON.stringify(upgradedKey)}.`,
      );
      changed = true;
    }
    if (upgradedKey && !Object.hasOwn(next, nextKey) && Object.hasOwn(record, nextKey)) {
      // Seed the canonical entry before its retired aliases so canonical conflict
      // precedence and per-alias change reporting do not depend on authored key order.
      setRecordEntry(next, nextKey, record[nextKey]);
      consumedCanonicalKeys.add(nextKey);
    }
    if (Object.hasOwn(next, nextKey)) {
      const existing = next[nextKey];
      const { value, conflicts } = mergeModelRefMapEntries(
        existing,
        child,
        `${path}.${nextKey}`,
        normalize,
      );
      setRecordEntry(next, nextKey, value);
      const sortedConflicts = conflicts.toSorted();
      if (sortedConflicts.length > 0) {
        changes.push(
          `Merged ${path} key ${JSON.stringify(key)} into ${JSON.stringify(nextKey)}; kept existing values for conflicting fields: ${sortedConflicts.join(", ")}.`,
        );
      } else {
        changes.push(`Merged ${path} key ${JSON.stringify(key)} into ${JSON.stringify(nextKey)}.`);
      }
      continue;
    }
    setRecordEntry(next, nextKey, child);
  }
  return { value: changed ? next : record, changed };
}

type ProviderCatalogModelRow = {
  index: number;
  model: unknown;
  modelRecord?: Record<string, unknown>;
  originalId?: string;
  normalizedId?: string;
  changed?: boolean;
};

function rewriteProviderCatalogModelIds(
  providers: Record<string, unknown>,
  path: string,
  changes: string[],
): { value: Record<string, unknown>; changed: boolean } {
  let changed = false;
  const next: Record<string, unknown> = { ...providers };
  for (const [providerId, providerValue] of Object.entries(providers)) {
    const provider = getRecord(providerValue);
    if (!provider || !Array.isArray(provider.models)) {
      continue;
    }
    const rows: ProviderCatalogModelRow[] = provider.models.map((model, index) => {
      const modelRecord = getRecord(model);
      if (!modelRecord || typeof modelRecord.id !== "string") {
        return { index, model };
      }
      const normalizedId = normalizeProviderCatalogModelId(providerId, modelRecord.id);
      return {
        index,
        model,
        modelRecord,
        originalId: modelRecord.id,
        normalizedId,
        changed: normalizedId !== modelRecord.id,
      };
    });
    if (!rows.some((row) => row.changed)) {
      continue;
    }

    const rowsById = new Map<string, typeof rows>();
    for (const row of rows) {
      if (row.normalizedId === undefined) {
        continue;
      }
      const grouped = rowsById.get(row.normalizedId) ?? [];
      grouped.push(row);
      rowsById.set(row.normalizedId, grouped);
    }
    const emittedIds = new Set<string>();
    const models: unknown[] = [];
    for (const row of rows) {
      if (row.normalizedId === undefined || row.modelRecord === undefined) {
        models.push(row.model);
        continue;
      }
      const grouped = rowsById.get(row.normalizedId) ?? [row];
      if (!grouped.some((candidate) => candidate.changed)) {
        models.push(row.model);
        continue;
      }
      if (emittedIds.has(row.normalizedId)) {
        continue;
      }
      emittedIds.add(row.normalizedId);

      const preferred =
        grouped.find((candidate) => candidate.originalId === candidate.normalizedId) ?? grouped[0];
      const preferredRecord = preferred?.modelRecord;
      if (!preferred || !preferredRecord) {
        models.push(row.model);
        continue;
      }
      let merged: Record<string, unknown> = { ...preferredRecord, id: row.normalizedId };
      for (const candidate of grouped) {
        if (candidate === preferred || !candidate.modelRecord) {
          continue;
        }
        const result = mergeModelRefMapEntries(
          merged,
          { ...candidate.modelRecord, id: row.normalizedId },
          `${path}.${providerId}.models.${preferred.index}`,
        );
        merged = getRecord(result.value) ?? merged;
        changes.push(
          result.conflicts.length > 0
            ? `Merged ${path}.${providerId}.models.${candidate.index} into model id ${JSON.stringify(row.normalizedId)}; kept canonical values for conflicting fields: ${result.conflicts.toSorted().join(", ")}.`
            : `Merged ${path}.${providerId}.models.${candidate.index} into model id ${JSON.stringify(row.normalizedId)}.`,
        );
      }
      for (const candidate of grouped) {
        if (!candidate.changed) {
          continue;
        }
        changes.push(
          `Upgraded ${path}.${providerId}.models.${candidate.index}.id from ${JSON.stringify(candidate.originalId)} to ${JSON.stringify(candidate.normalizedId)}.`,
        );
      }
      models.push(merged);
    }
    next[providerId] = { ...provider, models };
    changed = true;
  }
  return { value: changed ? next : providers, changed };
}

export function rewriteModelRefs(
  value: unknown,
  path: string,
  changes: string[],
  normalize: ModelRefNormalizer,
): { value: unknown; changed: boolean } {
  const key = pathKey(path);
  if (typeof value === "string") {
    if (
      !MODEL_REF_STRING_KEYS.has(key) &&
      !isChannelModelOverridePath(path) &&
      !isMediaModelPath(path)
    ) {
      return { value, changed: false };
    }
    const next = rewriteModelRefString(value, path, changes, normalize);
    return { value: next, changed: next !== value };
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((entry, index) => {
      if (
        typeof entry === "string" &&
        (MODEL_REF_ARRAY_KEYS.has(key) || isModelPolicyAllowPath(path))
      ) {
        const rewritten = rewriteModelRefString(entry, `${path}.${index}`, changes, normalize);
        changed ||= rewritten !== entry;
        return rewritten;
      }
      const rewritten = rewriteModelRefs(entry, `${path}.${index}`, changes, normalize);
      changed ||= rewritten.changed;
      return rewritten.value;
    });
    return { value: changed ? next : value, changed };
  }
  const record = getRecord(value);
  if (!record) {
    return { value, changed: false };
  }
  let working = record;
  let changed = false;
  const provider = typeof record.provider === "string" ? record.provider : undefined;
  const model = typeof record.model === "string" ? record.model : undefined;
  const providerModelPair = provider !== undefined && model !== undefined;
  if (provider?.trim() && model !== undefined) {
    const ref = `${provider}/${model}`;
    const rewritten = normalize(ref);
    if (rewritten && rewritten !== ref) {
      const slash = rewritten.indexOf("/");
      working = {
        ...record,
        provider: rewritten.slice(0, slash),
        model: rewritten.slice(slash + 1),
      };
      changes.push(
        `Upgraded ${path} provider/model from ${JSON.stringify(ref)} to ${JSON.stringify(rewritten)}.`,
      );
      changed = true;
    }
  }
  if (normalize === normalizeKnownModelRef && isProviderCatalogsPath(path)) {
    const rewrittenCatalogs = rewriteProviderCatalogModelIds(working, path, changes);
    working = rewrittenCatalogs.value;
    changed ||= rewrittenCatalogs.changed;
  }
  if (MODEL_REF_MAP_KEYS.has(key)) {
    const rewrittenKeys = rewriteModelRefMapKeys(working, path, changes, normalize);
    working = rewrittenKeys.value;
    changed ||= rewrittenKeys.changed;
  }
  const next: Record<string, unknown> = {};
  for (const [childKey, child] of Object.entries(working)) {
    const rewritten =
      providerModelPair && childKey === "model"
        ? { value: child, changed: false }
        : rewriteModelRefs(child, `${path}.${childKey}`, changes, normalize);
    changed ||= rewritten.changed;
    setRecordEntry(next, childKey, rewritten.value);
  }
  return { value: changed ? next : value, changed };
}

export const MODEL_REF_CANONICALIZATION_MESSAGE =
  'Configured retired or noncanonical model refs are no longer in the bundled catalogs; run "openclaw doctor --fix" to upgrade them.';

export function rewriteKnownModelRefs(
  value: unknown,
  path: string,
  changes: string[],
): { value: unknown; changed: boolean } {
  return rewriteModelRefs(value, path, changes, normalizeKnownModelRef);
}
