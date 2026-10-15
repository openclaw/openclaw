import {
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
  params: Pick<SessionTranscriptProjectionReceipt, "path" | "sessionId"> & { sessionKey?: string },
): SessionTranscriptProjectionReceipt | undefined {
  for (const cell of cells) {
    const { database, sessionKey } = cell.target;
    const snapshot = cell.snapshot;
    if (
      database.kind !== "file" ||
      database.nativeLocation !== params.path ||
      (params.sessionKey !== undefined && sessionKey !== params.sessionKey) ||
      snapshot?.entry?.sessionId !== params.sessionId ||
      !snapshot.transcript.projection
    ) {
      continue;
    }
    touch(cell);
    return {
      path: database.nativeLocation,
      sessionId: params.sessionId,
      entrySessionKey: sessionKey,
      writeToken: snapshot.writeToken,
      writeScopes: [
        ...collectSessionEntryLookupKeys(sessionKey),
        ...snapshot.dependencySessionIds.map(sqliteSessionIdWriteScope),
      ],
      facts: snapshot.transcript.projection,
    };
  }
  return undefined;
}
