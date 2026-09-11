// Creates and applies JSON merge-patch updates to config-like objects.
import { isDeepStrictEqual } from "node:util";
import { isPlainObject } from "../infra/plain-object.js";
import { isRecord } from "../utils.js";
import { formatConfigPatchPath, isMergePatchObjectKeyAllowed } from "./patch-replace-paths.js";

type PlainObject = Record<string, unknown>;

type MergePatchOptions = {
  mergeObjectArraysById?: boolean;
  replaceArrayPaths?: ReadonlySet<string>;
  path?: string;
};

function cloneUnknown<T>(value: T): T {
  return structuredClone(value);
}

/** Builds a merge patch; ID-keyed array mode emits changed fields for upserts. */
export function createMergePatch(
  base: unknown,
  target: unknown,
  options: Pick<MergePatchOptions, "mergeObjectArraysById"> = {},
): unknown {
  if (!isRecord(base) || !isRecord(target)) {
    return cloneUnknown(target);
  }

  const patch: Record<string, unknown> = {};
  const keys = new Set([...Object.keys(base), ...Object.keys(target)]);
  for (const key of keys) {
    const hasBase = Object.hasOwn(base, key);
    const hasTarget = Object.hasOwn(target, key);
    if (!hasTarget) {
      patch[key] = null;
      continue;
    }
    const targetValue = target[key];
    if (!hasBase) {
      patch[key] = cloneUnknown(targetValue);
      continue;
    }
    const baseValue = base[key];
    if (options.mergeObjectArraysById && isIdKeyedArray(baseValue) && isIdKeyedArray(targetValue)) {
      const baseById = new Map(baseValue.map((entry) => [entry.id, entry]));
      const updates: PlainObject[] = [];
      for (const entry of targetValue) {
        const baseEntry = baseById.get(entry.id);
        const update = createMergePatch(
          baseEntry,
          applyMergePatch(baseEntry, entry, options),
          options,
        );
        if (isRecord(update) && Object.keys(update).length > 0) {
          updates.push({ ...update, id: entry.id });
        }
      }
      if (updates.length > 0) {
        patch[key] = updates;
      }
      continue;
    }
    if (isRecord(baseValue) && isRecord(targetValue)) {
      const childPatch = createMergePatch(baseValue, targetValue, options);
      if (isRecord(childPatch) && Object.keys(childPatch).length === 0) {
        continue;
      }
      patch[key] = childPatch;
      continue;
    }
    if (!isDeepStrictEqual(baseValue, targetValue)) {
      patch[key] = cloneUnknown(targetValue);
    }
  }
  return patch;
}

/** Whether a merge patch would replace a value changed since its source was read. */
export function mergePatchConflicts(
  base: unknown,
  current: unknown,
  patch: unknown,
  options: Pick<MergePatchOptions, "mergeObjectArraysById"> = {},
): boolean {
  if (
    options.mergeObjectArraysById &&
    isIdKeyedArray(base) &&
    isIdKeyedArray(current) &&
    isIdKeyedArray(patch)
  ) {
    const baseById = new Map(base.map((entry) => [entry.id, entry]));
    const currentById = new Map(current.map((entry) => [entry.id, entry]));
    return patch.some((entry) =>
      mergePatchConflicts(baseById.get(entry.id), currentById.get(entry.id), entry, options),
    );
  }
  if (!isRecord(patch)) {
    return !isDeepStrictEqual(base, current);
  }
  const baseIsObject = isRecord(base);
  const currentIsObject = isRecord(current);
  if (baseIsObject !== currentIsObject && base !== undefined) {
    return true;
  }
  if (!baseIsObject && !currentIsObject && !isDeepStrictEqual(base, current)) {
    return true;
  }
  const baseRecord = baseIsObject ? base : {};
  const currentRecord = currentIsObject ? current : {};
  return Object.entries(patch).some(([key, childPatch]) =>
    mergePatchConflicts(baseRecord[key], currentRecord[key], childPatch, options),
  );
}

function isObjectWithStringId(value: unknown): value is Record<string, unknown> & { id: string } {
  if (!isPlainObject(value)) {
    return false;
  }
  return typeof value.id === "string" && value.id.length > 0;
}

function isIdKeyedArray(value: unknown): value is (PlainObject & { id: string })[] {
  return Array.isArray(value) && value.every(isObjectWithStringId);
}

function formatMergePatchArrayEntryPath(arrayPath: string): string {
  return `${arrayPath}[]`;
}

/**
 * Merge arrays of object-like entries keyed by `id`.
 *
 * Contract:
 * - Base array must be fully id-keyed; otherwise return undefined (caller should replace).
 * - Patch entries with valid id merge by id (or append when the id is new).
 * - Patch entries without valid id append as-is, avoiding destructive full-array replacement.
 */
function mergeObjectArraysById(
  base: unknown[],
  patch: unknown[],
  options: MergePatchOptions,
  arrayPath: string,
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
      merged.push(structuredClone(patchEntry));
      continue;
    }

    const existingIndex = indexById.get(patchEntry.id);
    if (existingIndex === undefined) {
      merged.push(structuredClone(patchEntry));
      indexById.set(patchEntry.id, merged.length - 1);
      continue;
    }

    merged[existingIndex] = applyMergePatch(merged[existingIndex], patchEntry, {
      ...options,
      path: formatMergePatchArrayEntryPath(arrayPath),
    });
  }

  return merged;
}

/**
 * Applies an RFC 7396-style object merge patch with OpenClaw config safeguards.
 *
 * Non-object patches replace the base, `null` deletes keys, blocked prototype
 * keys are ignored outside schema-owned record-key paths, and id-keyed arrays
 * may merge when the caller opts in.
 */
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
    const path = formatConfigPatchPath(options.path, key);
    if (!isMergePatchObjectKeyAllowed(key, options.path)) {
      continue;
    }
    if (value === null) {
      delete result[key];
      continue;
    }
    if (options.mergeObjectArraysById && Array.isArray(result[key]) && Array.isArray(value)) {
      if (options.replaceArrayPaths?.has(path)) {
        result[key] = value;
        continue;
      }
      // Config arrays like agents/plugins can patch by id; non-id arrays keep RFC replacement.
      const mergedArray = mergeObjectArraysById(result[key] as unknown[], value, options, path);
      if (mergedArray) {
        result[key] = mergedArray;
        continue;
      }
    }
    if (isPlainObject(value)) {
      const baseValue = result[key];
      result[key] = applyMergePatch(isPlainObject(baseValue) ? baseValue : {}, value, {
        ...options,
        path,
      });
      continue;
    }
    result[key] = value;
  }

  return result;
}
