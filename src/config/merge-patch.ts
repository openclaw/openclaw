import { isPlainObject } from "../utils.js";

type PlainObject = Record<string, unknown>;

type MergePatchOptions = {
  mergeObjectArraysById?: boolean;
};

function isObjectWithStringId(value: unknown): value is Record<string, unknown> & { id: string } {
  if (!isPlainObject(value)) {
    return false;
  }
  return typeof value.id === "string" && value.id.length > 0;
}

function mergeObjectArraysById(base: unknown[], patch: unknown[], options: MergePatchOptions) {
  // Require all *base* entries to have string ids — if the existing array
  // isn't id-keyed there's nothing sensible to merge against.
  if (!base.every(isObjectWithStringId)) {
    return undefined;
  }

  const merged = [...base] as Array<Record<string, unknown> & { id: string }>;
  const indexById = new Map<string, number>();
  for (const [index, entry] of merged.entries()) {
    indexById.set(entry.id, index);
  }

  for (const patchEntry of patch) {
    // Patch entries without a valid id are appended as-is (best-effort).
    // This prevents the entire merge from falling back to full replacement
    // just because one patch element is missing an id field.
    if (!isObjectWithStringId(patchEntry)) {
      merged.push(structuredClone(patchEntry) as Record<string, unknown> & { id: string });
      continue;
    }

    const existingIndex = indexById.get(patchEntry.id);
    if (existingIndex === undefined) {
      merged.push(structuredClone(patchEntry));
      indexById.set(patchEntry.id, merged.length - 1);
      continue;
    }
    merged[existingIndex] = applyMergePatch(merged[existingIndex], patchEntry, options) as Record<
      string,
      unknown
    > & { id: string };
  }

  return merged;
}

export function applyMergePatch(
  base: unknown,
  patch: unknown,
  options: MergePatchOptions = {},
): unknown {
  if (!isPlainObject(patch)) {
    return patch;
  }

  const result: PlainObject = isPlainObject(base) ? { ...base } : {};

  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete result[key];
      continue;
    }
    if (options.mergeObjectArraysById && Array.isArray(result[key]) && Array.isArray(value)) {
      const mergedArray = mergeObjectArraysById(result[key] as unknown[], value, options);
      if (mergedArray) {
        result[key] = mergedArray;
        continue;
      }
    }
    if (isPlainObject(value)) {
      const baseValue = result[key];
      result[key] = applyMergePatch(isPlainObject(baseValue) ? baseValue : {}, value, options);
      continue;
    }
    result[key] = value;
  }

  return result;
}
