import { getPostgresPhysicalFactsForPath } from "../../infra/database-engine/physical-facts.js";
import {
  getSqliteDatabaseAdmissionIdentityForPath,
  sqliteSessionIdWriteScope,
  readSqliteDatabaseScopedWriteTokenForPath,
  readSqliteDatabaseScopedWriteTokensForPath,
} from "../../infra/sqlite-database-admission.js";
import type { SessionRowChange } from "../../sessions/session-row-changes.js";
import { readPreparedSessionEntryPublicationSource } from "./session-accessor.sqlite-entry-cache-publication-state.js";
import type { SessionActorHotState } from "./session-actor-contract.js";
import type { FileTarget, ReplicaCell } from "./session-actor-replica.types.js";
import type { SessionTranscriptProjectionReceipt } from "./session-transcript-projection-facts.types.js";
import { collectSessionEntryLookupKeys } from "./store-entry.js";

/** Configured path spellings share the identity already established by admission. */
export function* sessionActorReplicaCellsForPath(cells: Iterable<ReplicaCell>, path: string) {
  const identity = getSqliteDatabaseAdmissionIdentityForPath(path);
  if (!identity) {
    return;
  }
  const postgres = getPostgresPhysicalFactsForPath(path);
  for (const cell of cells) {
    const { database } = cell.target;
    if (database.kind !== "file") {
      continue;
    }
    if (postgres) {
      // A retired replica must not discover or admit its old pathname while reading.
      if (!getSqliteDatabaseAdmissionIdentityForPath(database.nativeLocation)) {
        continue;
      }
      const candidate = getPostgresPhysicalFactsForPath(database.nativeLocation);
      if (candidate?.namespace === postgres.namespace && candidate.storeId === postgres.storeId) {
        yield cell;
      }
    } else if (
      identity.key === `file:${database.physicalIdentity}` &&
      identity.birthtime === database.birthtime
    ) {
      yield cell;
    }
  }
}

function writeScopes(target: FileTarget, sessionIds: readonly string[]) {
  return [
    ...collectSessionEntryLookupKeys(target.sessionKey),
    ...sessionIds.map(sqliteSessionIdWriteScope),
  ];
}

export function scopedWriteToken(target: FileTarget, sessionIds: readonly string[]) {
  return readSqliteDatabaseScopedWriteTokenForPath(
    target.database.nativeLocation,
    writeScopes(target, sessionIds),
  );
}

export function scopedWriteTokens(
  database: FileTarget["database"],
  entries: readonly { target: FileTarget; dependencySessionIds: readonly string[] }[],
) {
  return readSqliteDatabaseScopedWriteTokensForPath(
    database.nativeLocation,
    entries.map(({ target, dependencySessionIds }) => writeScopes(target, dependencySessionIds)),
  );
}

export function readSessionActorParticipantPostimage(
  target: FileTarget,
  snapshot: SessionActorHotState | undefined,
  change: SessionRowChange,
): SessionActorHotState | undefined {
  if (
    "all" in change ||
    change.sessionKey !== target.sessionKey ||
    change.factsInvalidated ||
    change.facts?.kind !== "participants" ||
    change.facts.projectionChanged !== false ||
    !change.facts.records ||
    !change.facts.actorVersion ||
    !snapshot ||
    readPreparedSessionEntryPublicationSource(change).identity !== target.database.physicalIdentity
  ) {
    return undefined;
  }
  const writeToken = scopedWriteToken(target, snapshot.dependencySessionIds);
  return writeToken
    ? {
        ...snapshot,
        participants: [...change.facts.records],
        version: change.facts.actorVersion,
        writeToken,
      }
    : undefined;
}

/** The receiving worker checks this receipt against its admitted database once. */
export function readSessionActorProjectionReceiptFromCells(
  cells: Iterable<ReplicaCell>,
  touch: (cell: ReplicaCell) => void,
  params: { path: string; sessionId: string; sessionKey?: string },
): SessionTranscriptProjectionReceipt | undefined {
  for (const cell of sessionActorReplicaCellsForPath(cells, params.path)) {
    const { sessionKey } = cell.target;
    const snapshot = cell.snapshot;
    if (
      (params.sessionKey !== undefined && sessionKey !== params.sessionKey) ||
      snapshot?.entry?.sessionId !== params.sessionId ||
      (!snapshot.transcript.projection && !snapshot.transcript.contextStats)
    ) {
      continue;
    }
    touch(cell);
    return {
      sessionId: params.sessionId,
      entrySessionKey: sessionKey,
      writeToken: snapshot.writeToken,
      writeScopes: [
        ...collectSessionEntryLookupKeys(sessionKey),
        ...snapshot.dependencySessionIds.map(sqliteSessionIdWriteScope),
      ],
      facts: snapshot.transcript.projection,
      contextStats: snapshot.transcript.contextStats,
    };
  }
  return undefined;
}
