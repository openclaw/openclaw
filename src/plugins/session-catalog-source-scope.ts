import type { SessionEntry } from "../config/sessions.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { SessionCatalogEntrySnapshot } from "./session-catalog.js";

type SourceQuery = {
  pluginId: string;
  sourceFromEntry: (entry: SessionEntry) => { hostId: string; threadId: string } | undefined;
};
type Scope = { queries: SourceQuery[]; depth: number; unscoped: boolean };
const scopes = resolveGlobalSingleton(
  Symbol.for("openclaw.sessionCatalogSourceQueries"),
  () => new WeakMap<object, Scope>(),
);
function scopeFor(snapshot: object): Scope {
  let scope = scopes.get(snapshot);
  if (!scope) {
    scope = { queries: [], depth: 0, unscoped: false };
    scopes.set(snapshot, scope);
  }
  return scope;
}
/** A raw metadata lookup cannot certify a complete canonical adoption query. */
export function noteSessionCatalogEntryRead(snapshot: object) {
  const scope = scopeFor(snapshot);
  if (!scope.depth) {
    scope.unscoped = true;
  }
}
/** Record the existing adoption owner's neutral query; this never grants access. */
export function readSessionCatalogAdoptedEntries<T>(
  snapshot: SessionCatalogEntrySnapshot | undefined,
  query: SourceQuery,
  read: () => T,
): T {
  if (!snapshot) {
    return read();
  }
  const scope = scopeFor(snapshot);
  if (
    !scope.queries.some(
      (old) => old.pluginId === query.pluginId && old.sourceFromEntry === query.sourceFromEntry,
    )
  ) {
    scope.queries.push(query);
  }
  scope.depth++;
  try {
    return read();
  } finally {
    scope.depth--;
  }
}
/** Unknown or mixed lookup semantics stay conservative; no new provider capability is required. */
export function retainSessionCatalogSourceScope(
  snapshot: object,
  hostId: string,
  threadId: string,
): ((entry: SessionEntry, complete: boolean) => boolean | undefined) | undefined {
  const scope = scopes.get(snapshot);
  if (!scope || scope.unscoped || !scope.queries.length) {
    return undefined;
  }
  const queries = [...scope.queries];
  return (entry, complete) => {
    if (scope.unscoped) {
      return undefined;
    }
    const owners = queries.filter((query) => query.pluginId === entry.pluginOwnerId);
    if (!owners.length) {
      return false;
    }
    if (!complete) {
      return undefined;
    }
    try {
      const matched = owners.some((query) => {
        const source = query.sourceFromEntry(entry);
        return source?.hostId === hostId && source.threadId === threadId;
      });
      return scope.unscoped ? undefined : matched;
    } catch {
      return undefined;
    }
  };
}
