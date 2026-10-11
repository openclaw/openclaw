import type { DatabaseSync } from "node:sqlite";
import { serialize } from "node:v8";
import { readSqliteDatabasePendingWriteToken } from "../../infra/sqlite-database-admission.js";
import { readSqliteNativeMutationRevision } from "../../infra/sqlite-schema-facts.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import type { SessionEntryPublicationSource } from "./session-accessor.sqlite-entry-cache.types.js";

const MAX_SESSION_ENTRY_PUBLICATION_BYTES = 8 * 1024 * 1024;

/** Optional cache facts cannot consume the required receipt's transport allowance. */
export function hasSessionEntryPublicationCapacity(envelope: unknown): boolean {
  try {
    return serialize(envelope).byteLength <= MAX_SESSION_ENTRY_PUBLICATION_BYTES;
  } catch {
    return false;
  }
}

const selectedSources = resolveGlobalSingleton(
  Symbol.for("openclaw.sessionEntryPublicationSources"),
  () =>
    new WeakMap<
      SessionEntryPublicationSource,
      { database: DatabaseSync; mutationRevision: number }
    >(),
);

/** Selection and final serialization must describe the same native transaction state. */
export function captureSessionEntryPublicationSource(
  database: DatabaseSync,
  source: SessionEntryPublicationSource,
): SessionEntryPublicationSource {
  const mutationRevision = readSqliteNativeMutationRevision(database);
  if (mutationRevision !== undefined) {
    selectedSources.set(source, { database, mutationRevision });
  }
  return source;
}

/** Called only at the writer's final candidate serialization, after its last row mutation. */
export function sealSessionEntryPublicationSource(source: SessionEntryPublicationSource): void {
  const selected = selectedSources.get(source);
  source.writeToken =
    selected && readSqliteNativeMutationRevision(selected.database) === selected.mutationRevision
      ? readSqliteDatabasePendingWriteToken(selected.database)
      : undefined;
}
