type PlainObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is PlainObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Check if an array contains objects with "id" fields (like agents.list).
 */
function isIdBasedArray(arr: unknown[]): arr is Array<PlainObject & { id: string }> {
  if (arr.length === 0) return false;
  return arr.every((item) => isPlainObject(item) && typeof (item as PlainObject).id === "string");
}

/**
 * Merge two arrays by "id" field. Patch items update/add to base items.
 * Items in base that aren't in patch are preserved.
 * Items in patch with id not in base are appended.
 */
function mergeArraysById(
  base: Array<PlainObject & { id: string }>,
  patch: Array<PlainObject & { id: string }>,
): Array<PlainObject & { id: string }> {
  const result = [...base];
  const baseIndex = new Map(base.map((item, idx) => [item.id, idx]));

  for (const patchItem of patch) {
    const existingIdx = baseIndex.get(patchItem.id);
    if (existingIdx !== undefined) {
      // Merge the patch item into the existing item (deep merge)
      result[existingIdx] = applyMergePatch(result[existingIdx], patchItem) as PlainObject & {
        id: string;
      };
    } else {
      // New item, append to the list
      result.push(patchItem);
    }
  }

  return result;
}

export function applyMergePatch(base: unknown, patch: unknown): unknown {
  // Handle top-level id-based arrays
  if (Array.isArray(patch) && isIdBasedArray(patch)) {
    if (Array.isArray(base) && isIdBasedArray(base)) {
      return mergeArraysById(base, patch);
    }
    return patch;
  }

  if (!isPlainObject(patch)) {
    return patch;
  }

  const result: PlainObject = isPlainObject(base) ? { ...base } : {};

  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete result[key];
      continue;
    }
    if (isPlainObject(value)) {
      const baseValue = result[key];
      result[key] = applyMergePatch(isPlainObject(baseValue) ? baseValue : {}, value);
      continue;
    }
    // Handle arrays with "id" fields specially - merge by id instead of replacing
    if (Array.isArray(value) && isIdBasedArray(value)) {
      const baseValue = result[key];
      if (Array.isArray(baseValue) && isIdBasedArray(baseValue)) {
        result[key] = mergeArraysById(baseValue, value);
        continue;
      }
    }
    result[key] = value;
  }

  return result;
}
