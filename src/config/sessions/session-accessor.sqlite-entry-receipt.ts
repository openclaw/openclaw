import type { SessionEntryReplacementPublication } from "./session-accessor.sqlite-entry-cache.types.js";

/** The typed worker owns receipt shape; installation checks only its physical target and keys. */
export function isSessionEntryReplacementReceiptUsable(
  publication: SessionEntryReplacementPublication,
  keys: readonly string[],
  databaseIdentity: string,
): boolean {
  const affected = new Set(publication.changedKeys);
  return (
    (!publication.source || publication.source.identity === databaseIdentity) &&
    affected.size === keys.length &&
    keys.every((key) => affected.has(key))
  );
}
