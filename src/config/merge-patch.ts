import { isPlainObject } from "../utils.js";
import { isBlockedObjectKey } from "./prototype-keys.js";

type PlainObject = Record<string, unknown>;

type MergePatchOptions = {
  mergeObjectArraysById?: boolean;
};

// Guard against stack overflow from deeply nested patches (e.g. attacker-controlled
// config input). 64 levels is far beyond any legitimate configuration depth.
const MAX_MERGE_PATCH_DEPTH = 64;

// Guard against memory exhaustion from unbounded array growth when merging
// id-keyed arrays. 10,000 entries is generous for any real configuration list.
const MAX_MERGE_ARRAY_LENGTH = 10_000;

function isObjectWithStringId(value: unknown): value is Record<string, unknown> & { id: string } {
  if (!isPlainObject(value)) {
    return false;
  }
  return typeof value.id === "string" && value.id.length > 0;
}

/**
 * Merge arrays of object-like entries keyed by `id`.
 *
 * Contract:
 * - Base array must be fully id-keyed; otherwise return undefined (caller should replace).
 * - Patch entries with valid id merge by id (or append when the id is new).
 * - Patch entries without valid id append as-is, avoiding destructive full-array replacement.
 * - Merged result is capped at MAX_MERGE_ARRAY_LENGTH; exceeding triggers full replacement.
 */
function mergeObjectArraysById(
  base: unknown[],
  patch: unknown[],
  options: MergePatchOptions,
  depth: number,
): unknown[] | undefined {
  if (!base.every(isObjectWithStringId)) {
    return undefined;
  }

  const merged: unknown[] = [...base];
  const indexById = new Map<string, number>();
  for (const [index, entry] of merged.entries()) {
    if (!isObjectWithStringId(entry)) {
      return undefined;
    }
    indexById.set(entry.id, index);
  }

  for (const patchEntry of patch) {
    if (!isObjectWithStringId(patchEntry)) {
      // Bail out if merged array would exceed the safety limit.
      if (merged.length >= MAX_MERGE_ARRAY_LENGTH) {
        return undefined;
      }
      merged.push(structuredClone(patchEntry));
      continue;
    }

    const existingIndex = indexById.get(patchEntry.id);
    if (existingIndex === undefined) {
      // Bail out if merged array would exceed the safety limit.
      if (merged.length >= MAX_MERGE_ARRAY_LENGTH) {
        return undefined;
      }
      merged.push(structuredClone(patchEntry));
      indexById.set(patchEntry.id, merged.length - 1);
      continue;
    }

    merged[existingIndex] = applyMergePatchInternal(
      merged[existingIndex],
      patchEntry,
      options,
      depth + 1,
    );
  }

  return merged;
}

/**
 * Internal recursive implementation with depth tracking.
 * When depth exceeds MAX_MERGE_PATCH_DEPTH, the patch value is returned
 * as-is (via structuredClone) to prevent stack overflow.
 */
function applyMergePatchInternal(
  base: unknown,
  patch: unknown,
  options: MergePatchOptions,
  depth: number,
): unknown {
  if (!isPlainObject(patch)) {
    return patch;
  }

  // Safety: stop recursing when depth is excessive. Return a deep copy of the
  // patch to preserve correctness without risking a stack overflow.
  if (depth >= MAX_MERGE_PATCH_DEPTH) {
    return structuredClone(patch);
  }

  const result: PlainObject = isPlainObject(base) ? { ...base } : {};

  for (const [key, value] of Object.entries(patch)) {
    if (isBlockedObjectKey(key)) {
      continue;
    }
    if (value === null) {
      delete result[key];
      continue;
    }
    if (options.mergeObjectArraysById && Array.isArray(result[key]) && Array.isArray(value)) {
      const mergedArray = mergeObjectArraysById(
        result[key] as unknown[],
        value,
        options,
        depth + 1,
      );
      if (mergedArray) {
        result[key] = mergedArray;
        continue;
      }
    }
    if (isPlainObject(value)) {
      const baseValue = result[key];
      result[key] = applyMergePatchInternal(
        isPlainObject(baseValue) ? baseValue : {},
        value,
        options,
        depth + 1,
      );
      continue;
    }
    result[key] = value;
  }

  return result;
}

export function applyMergePatch(
  base: unknown,
  patch: unknown,
  options: MergePatchOptions = {},
): unknown {
  return applyMergePatchInternal(base, patch, options, 0);
}

