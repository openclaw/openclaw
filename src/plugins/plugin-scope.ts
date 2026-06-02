import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";

/** Plugin-id scope where `undefined` means unscoped and an empty array means explicit empty scope. */
export type PluginIdScope = readonly string[] | undefined;

/** Normalizes plugin-id scope inputs into sorted unique ids while preserving undefined as unscoped. */
export function normalizePluginIdScope(ids?: readonly unknown[]): string[] | undefined {
  if (ids === undefined) {
    return undefined;
  }
  return Array.from(
    new Set(normalizeStringEntries(ids.filter((id): id is string => typeof id === "string"))),
  ).toSorted();
}

/** Returns whether callers explicitly supplied a scope, even if the scope is empty. */
export function hasExplicitPluginIdScope(ids?: readonly string[]): boolean {
  return ids !== undefined;
}

/** Returns whether callers supplied a scope with at least one plugin id. */
export function hasNonEmptyPluginIdScope(ids?: readonly string[]): boolean {
  return ids !== undefined && ids.length > 0;
}

/** Creates a lookup set for explicit scopes; null means no scope filter should apply. */
export function createPluginIdScopeSet(ids?: readonly string[]): ReadonlySet<string> | null {
  if (ids === undefined) {
    return null;
  }
  return new Set(ids);
}

/** Serializes scopes for cache keys without collapsing unscoped and explicit empty scopes. */
export function serializePluginIdScope(ids?: readonly string[]): string {
  return ids === undefined ? "__unscoped__" : JSON.stringify(ids);
}
