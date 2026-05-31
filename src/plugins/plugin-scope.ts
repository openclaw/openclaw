import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";

/** Undefined means unscoped; an array means an explicit plugin-id scope. */
export type PluginIdScope = readonly string[] | undefined;

/** Normalizes plugin scopes into stable sorted unique ids for cache keys. */
export function normalizePluginIdScope(ids?: readonly unknown[]): string[] | undefined {
  if (ids === undefined) {
    return undefined;
  }
  return Array.from(
    new Set(normalizeStringEntries(ids.filter((id): id is string => typeof id === "string"))),
  ).toSorted();
}

/** Distinguishes an explicit empty scope from an omitted unscoped request. */
export function hasExplicitPluginIdScope(ids?: readonly string[]): boolean {
  return ids !== undefined;
}

/** Returns true only when a scope was provided and contains at least one id. */
export function hasNonEmptyPluginIdScope(ids?: readonly string[]): boolean {
  return ids !== undefined && ids.length > 0;
}

/** Converts an explicit scope into a set while preserving null for unscoped reads. */
export function createPluginIdScopeSet(ids?: readonly string[]): ReadonlySet<string> | null {
  if (ids === undefined) {
    return null;
  }
  return new Set(ids);
}

/** Serializes scopes for memo keys, preserving unscoped vs explicit-empty. */
export function serializePluginIdScope(ids?: readonly string[]): string {
  return ids === undefined ? "__unscoped__" : JSON.stringify(ids);
}
