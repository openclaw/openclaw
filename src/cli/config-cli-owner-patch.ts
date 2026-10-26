import { isDeepStrictEqual } from "node:util";
import { applyMergePatch, createMergePatch } from "../config/merge-patch.js";
import { collectBaseArrayPaths, formatConfigPatchPath } from "../config/patch-replace-paths.js";
import type { OpenClawConfig } from "../config/types.js";
import { isPlainObject } from "../infra/plain-object.js";

// Matches the config.patch request schema.
const MAX_REPLACE_PATHS = 256;

// Arrays the patch replaces, or removes with a deleted or replaced subtree, are explicit intent.
function collectReplacePaths(patch: unknown, base: unknown, parentPath?: string): string[] {
  if (!isPlainObject(patch)) {
    return [];
  }
  return Object.entries(patch).flatMap(([key, value]) => {
    const path = formatConfigPatchPath(parentPath, key);
    const baseValue = isPlainObject(base) ? base[key] : undefined;
    if (isPlainObject(value)) {
      return collectReplacePaths(value, baseValue, path);
    }
    // Any non-object value (null, scalar or array) also removes the base arrays below it.
    const removed = collectBaseArrayPaths(baseValue, path);
    return Array.isArray(value) && !removed.includes(path) ? [path].concat(removed) : removed;
  });
}

/**
 * Express a prepared CLI change as one Gateway config.patch request against `baseHash`. Arrays replace or
 * delete exactly, as the local writer would; a change the Gateway's merge cannot reproduce
 * (for example an authored null) is refused instead of being approximated.
 */
export function buildConfigOwnerPatch(
  change: { previous: OpenClawConfig; next: OpenClawConfig },
  baseHash: unknown,
) {
  const patch = createMergePatch(change.previous, change.next);
  const replacePaths = collectReplacePaths(patch, change.previous);
  const replayed = applyMergePatch(change.previous, patch, {
    mergeObjectArraysById: true,
    replaceArrayPaths: new Set(replacePaths),
  });
  if (replacePaths.length > MAX_REPLACE_PATHS || !isDeepStrictEqual(replayed, change.next)) {
    throw new Error(
      "This change cannot be expressed as a Gateway config patch, so it was not sent to the running Gateway. No settings were saved. To apply it, stop the Gateway through its service owner, wait for ownership to release, then rerun this exact command.",
    );
  }
  // Only fields stable Gateways accept: their closed config.patch schema rejects newer ones
  // such as `response`, and an updated CLI routes to whichever Gateway is still running.
  return {
    raw: JSON.stringify(patch),
    ...(typeof baseHash === "string" ? { baseHash } : {}),
    ...(replacePaths.length > 0 ? { replacePaths } : {}),
  };
}
