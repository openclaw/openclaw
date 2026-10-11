import { isDeepStrictEqual } from "node:util";
import { isPlainObject } from "../../infra/plain-object.js";
import { diffConfigPaths } from "../config-diff.js";

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
