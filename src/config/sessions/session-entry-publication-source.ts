import { serialize } from "node:v8";
import {
  getPostgresPhysicalFacts,
  getPostgresPhysicalFactsForPath,
  type PostgresPhysicalFacts,
} from "../../infra/database-engine/physical-facts.js";
import { isPostgresSqlConnection, type EngineConnection } from "../../infra/sql-connection.js";
import {
  readSqliteDatabasePendingWriteToken,
  readSqliteDatabaseWriteTokenForPath,
} from "../../infra/sqlite-database-admission.js";
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
      { database: EngineConnection; mutationRevision: number }
    >(),
);

/** Dropped optional facts cannot be certified again when native publication settles. */
export function discardSessionEntryPublicationSource(source: SessionEntryPublicationSource): void {
  selectedSources.delete(source);
  delete source.writeToken;
}

/** Selection and final serialization must describe the same native transaction state. */
export function captureSessionEntryPublicationSource(
  database: EngineConnection,
  source: SessionEntryPublicationSource,
): SessionEntryPublicationSource {
  const mutationRevision = readSqliteNativeMutationRevision(database);
  if (isPostgresSqlConnection(database)) {
    const admission = getPostgresPhysicalFacts(database);
    if (!admission) {
      source.admission = null;
      return source;
    }
    const { engine, namespace, storeId, admissionId } = admission;
    source.admission = { engine, namespace, storeId, admissionId };
  }
  if (mutationRevision !== undefined) {
    selectedSources.set(source, { database, mutationRevision });
  }
  return source;
}

/** Seal final worker candidates or committed native publications after their last row mutation. */
export function sealSessionEntryPublicationSource(source: SessionEntryPublicationSource): void {
  const selected = selectedSources.get(source);
  if (
    selected &&
    isPostgresSqlConnection(selected.database) &&
    (!selected.database.isOpen ||
      !matchesAdmission(source, getPostgresPhysicalFacts(selected.database)))
  ) {
    delete source.writeToken;
    return;
  }
  source.writeToken =
    selected && readSqliteNativeMutationRevision(selected.database) === selected.mutationRevision
      ? selected.database.isTransaction
        ? readSqliteDatabasePendingWriteToken(selected.database)
        : readSqliteDatabaseWriteTokenForPath(source.canonicalPath ?? source.filename)
      : undefined;
}

function matchesAdmission(
  source: SessionEntryPublicationSource,
  current: PostgresPhysicalFacts | undefined,
): boolean {
  const captured = source.admission;
  if (captured === null) {
    return false;
  }
  return captured
    ? current?.namespace === captured.namespace &&
        current.storeId === captured.storeId &&
        current.admissionId === captured.admissionId
    : current === undefined;
}

/** Worker facts retain the admitted store identity independently of their anchor routing. */
export function isSessionEntryPublicationAdmissionCurrent(
  source: SessionEntryPublicationSource,
): boolean {
  return matchesAdmission(
    source,
    getPostgresPhysicalFactsForPath(source.canonicalPath ?? source.filename),
  );
}

/** A complete postimage may install only at its sealed commit, without opening a database. */
export function isSessionEntryPublicationSourceCurrent(
  source: SessionEntryPublicationSource,
): boolean {
  return (
    isSessionEntryPublicationAdmissionCurrent(source) &&
    (!source.admission || source.writeToken !== undefined) &&
    source.writeToken ===
      readSqliteDatabaseWriteTokenForPath(source.canonicalPath ?? source.filename)
  );
}
