import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import {
  collectBaseArrayPaths,
  formatConfigPatchPath,
  isMergePatchObjectKeyAllowed,
} from "../../config/patch-replace-paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isPlainObject } from "../../infra/plain-object.js";
import { diffConfigPaths } from "../config-diff.js";
import type { RespondFn } from "./types.js";

export function isHashlessPatchLwwPath(path: string): boolean {
  return path === "ui.prefs" || path.startsWith("ui.prefs.");
}

// ui.prefs alone permits hash-free leaf writes. Container replacement or deletion requires
// document CAS so a stale client cannot wipe preferences added by a concurrent writer.
export function hasHashlessPatchLwwStructure(patch: unknown): boolean {
  if (!isPlainObject(patch)) {
    return false;
  }
  if (!Object.hasOwn(patch, "ui")) {
    return true;
  }
  const ui = patch.ui;
  return isPlainObject(ui) && (!Object.hasOwn(ui, "prefs") || isPlainObject(ui.prefs));
}

export function diffConfigLeafPaths(prev: unknown, next: unknown, prefix = ""): string[] {
  if (isPlainObject(prev) || isPlainObject(next)) {
    const prevRecord = isPlainObject(prev) ? prev : {};
    const nextRecord = isPlainObject(next) ? next : {};
    const keys = [...new Set([...Object.keys(prevRecord), ...Object.keys(nextRecord)])];
    if (keys.length === 0) {
      return isDeepStrictEqual(prev, next) ? [] : [prefix || "<root>"];
    }
    return keys.flatMap((key) =>
      diffConfigLeafPaths(prevRecord[key], nextRecord[key], prefix ? `${prefix}.${key}` : key),
    );
  }
  return diffConfigPaths(prev, next, prefix);
}

function collectDestructiveArrayPatchPaths(params: {
  base: unknown;
  patch: unknown;
  merged: unknown;
  path?: string;
}): string[] {
  if (!isPlainObject(params.patch) || !isPlainObject(params.base)) {
    return [];
  }

  const merged = isPlainObject(params.merged) ? params.merged : {};
  const paths: string[] = [];
  for (const [key, patchValue] of Object.entries(params.patch)) {
    const path = formatConfigPatchPath(params.path ?? "", key);
    if (!isMergePatchObjectKeyAllowed(key, params.path)) {
      continue;
    }
    const baseValue = params.base[key];
    const mergedValue = merged[key];

    if (Array.isArray(baseValue)) {
      if (patchValue === null || !Array.isArray(patchValue)) {
        paths.push(path);
        continue;
      }
      if (Array.isArray(mergedValue)) {
        if (isConfigPatchIdKeyedArray(baseValue)) {
          if (!idKeyedArrayPreservesBaseIds(baseValue, mergedValue)) {
            paths.push(path);
            continue;
          }
          paths.push(
            ...collectDestructiveIdKeyedArrayEntryPatchPaths({
              base: baseValue,
              patch: patchValue,
              merged: mergedValue,
              path,
            }),
          );
        } else if (!arrayPreservesBaseEntries(baseValue, mergedValue)) {
          paths.push(path);
          continue;
        }
      }
    } else if (isPlainObject(baseValue) && !isPlainObject(patchValue)) {
      paths.push(...collectBaseArrayPaths(baseValue, path));
      continue;
    }

    if (isPlainObject(patchValue)) {
      paths.push(
        ...collectDestructiveArrayPatchPaths({
          base: baseValue,
          patch: patchValue,
          merged: mergedValue,
          path,
        }),
      );
    }
  }
  return paths;
}

function isConfigPatchObjectWithStringId(
  value: unknown,
): value is Record<string, unknown> & { id: string } {
  return isPlainObject(value) && typeof value.id === "string" && value.id.length > 0;
}

export function assertNoDuplicateConfigPatchIds(params: {
  patch: unknown;
  current: unknown;
  replacePaths: ReadonlySet<string>;
  path?: string;
}): void {
  const path = params.path ?? "";
  if (Array.isArray(params.patch)) {
    if (
      !Array.isArray(params.current) ||
      params.replacePaths.has(path) ||
      !isConfigPatchIdKeyedArray(params.current)
    ) {
      return;
    }
    // ID-keyed merge is sequential and would silently let the last duplicate win.
    // Reject only arrays using that merge contract; explicit replacements may contain duplicates.
    const currentIds = new Set<string>();
    for (const entry of params.current) {
      if (currentIds.has(entry.id)) {
        throw new Error(
          `Cannot ID-merge array at ${path || "<root>"}: current config contains duplicate ID ${entry.id}; use replacePaths for an explicit replacement.`,
        );
      }
      currentIds.add(entry.id);
    }
    const ids = new Set<string>();
    for (const entry of params.patch) {
      if (!isConfigPatchObjectWithStringId(entry)) {
        continue;
      }
      if (ids.has(entry.id)) {
        throw new Error(`Ambiguous duplicate ID ${entry.id} in array at ${path || "<root>"}.`);
      }
      ids.add(entry.id);
    }
    const currentById = new Map(params.current.map((entry) => [entry.id, entry] as const));
    for (const entry of params.patch) {
      if (!isConfigPatchObjectWithStringId(entry)) {
        continue;
      }
      const currentEntry = currentById.get(entry.id);
      if (currentEntry) {
        assertNoDuplicateConfigPatchIds({
          patch: entry,
          current: currentEntry,
          replacePaths: params.replacePaths,
          path: `${path}[]`,
        });
      }
    }
    return;
  }
  if (!isRecord(params.patch) || !isRecord(params.current)) {
    return;
  }
  for (const [key, child] of Object.entries(params.patch)) {
    assertNoDuplicateConfigPatchIds({
      patch: child,
      current: params.current[key],
      replacePaths: params.replacePaths,
      path: formatConfigPatchPath(path, key),
    });
  }
}

function isConfigPatchIdKeyedArray(
  value: unknown[],
): value is Array<Record<string, unknown> & { id: string }> {
  return value.every(isConfigPatchObjectWithStringId);
}

function idKeyedArrayPreservesBaseIds(
  base: Array<Record<string, unknown> & { id: string }>,
  merged: unknown[],
): boolean {
  const mergedIds = new Set(
    merged.filter(isConfigPatchObjectWithStringId).map((entry) => entry.id),
  );
  return base.every((entry) => mergedIds.has(entry.id));
}

function arrayPreservesBaseEntries(base: unknown[], merged: unknown[]): boolean {
  const unmatchedMerged = [...merged];
  for (const baseEntry of base) {
    const matchIndex = unmatchedMerged.findIndex((mergedEntry) =>
      isDeepStrictEqual(mergedEntry, baseEntry),
    );
    if (matchIndex === -1) {
      return false;
    }
    unmatchedMerged.splice(matchIndex, 1);
  }
  return true;
}

function collectDestructiveIdKeyedArrayEntryPatchPaths(params: {
  base: Array<Record<string, unknown> & { id: string }>;
  patch: unknown[];
  merged: unknown[];
  path: string;
}): string[] {
  const baseById = new Map(params.base.map((entry) => [entry.id, entry]));
  const mergedById = new Map(
    params.merged.filter(isConfigPatchObjectWithStringId).map((entry) => [entry.id, entry]),
  );
  const paths: string[] = [];
  for (const patchEntry of params.patch) {
    if (!isConfigPatchObjectWithStringId(patchEntry)) {
      continue;
    }
    const baseEntry = baseById.get(patchEntry.id);
    const mergedEntry = mergedById.get(patchEntry.id);
    if (!baseEntry || !mergedEntry) {
      continue;
    }
    paths.push(
      ...collectDestructiveArrayPatchPaths({
        base: baseEntry,
        patch: patchEntry,
        merged: mergedEntry,
        path: `${params.path}[]`,
      }),
    );
  }
  return paths;
}

export function rejectDestructiveArrayPatchWithoutIntent(params: {
  currentConfig: OpenClawConfig;
  mergedConfig: unknown;
  patch: unknown;
  replacePaths: Set<string>;
  respond: RespondFn;
}): boolean {
  const destructivePaths = collectDestructiveArrayPatchPaths({
    base: params.currentConfig,
    patch: params.patch,
    merged: params.mergedConfig,
  });
  const unconfirmedPaths = destructivePaths.filter((path) => !params.replacePaths.has(path));
  if (unconfirmedPaths.length === 0) {
    return false;
  }
  params.respond(
    false,
    undefined,
    errorShape(
      ErrorCodes.INVALID_REQUEST,
      `config.patch would remove entries from array path(s): ${unconfirmedPaths.join(", ")}. ` +
        `Pass replacePaths with the exact path(s) when this is intentional, or use config.apply for full-config replacement.`,
    ),
  );
  return true;
}
