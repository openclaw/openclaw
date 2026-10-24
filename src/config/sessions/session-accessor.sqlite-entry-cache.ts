import { toUSVString } from "node:util";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { readSqliteDatabaseSiblingWriteRevision } from "../../infra/sqlite-database-admission.js";
import {
  getAdmittedSqliteSchemaFacts,
  runSqliteReadOperationSync,
} from "../../infra/sqlite-schema-facts.js";
import type { SessionRowFacts } from "../../sessions/session-row-changes.js";
import { freezeJsonSnapshot } from "../../shared/immutable-data.js";
import { findOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import { readOpenClawAgentDatabase } from "../../state/openclaw-agent-db-readonly-open.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type { ExactSessionEntry } from "./session-accessor.sqlite-contract.js";
import {
  loadSessionEntrySnapshot,
  projectSessionEntryCacheMetadata,
  projectSessionEntryCacheUpdate,
  readSessionEntrySideMetadata,
  type SessionEntrySideMetadata,
} from "./session-accessor.sqlite-entry-cache-projection.js";
import {
  emitPreparedSessionSharingChange,
  publishSessionSharingEntryChange,
} from "./session-accessor.sqlite-entry-cache-publication.js";
import {
  publishTrackedCacheUpdate,
  sessionEntryCaches,
  type SqliteSessionEntryCache,
} from "./session-accessor.sqlite-entry-cache-state.js";
import type {
  SessionEntryCacheDatabase,
  SessionEntryCacheReadOptions,
  SessionEntryCacheSnapshot,
} from "./session-accessor.sqlite-entry-cache.types.js";
import {
  prepareExactSessionEntryRowReads,
  validateDeliveryCanonicalSessionEntry,
} from "./session-accessor.sqlite-entry-read.js";
import {
  cacheValidityTokensEqual,
  readSessionEntryCacheValidityToken,
  readSessionNodesGeneration,
} from "./session-accessor.sqlite-entry-revision.js";
import { readSqliteSessionParticipantProjection } from "./session-accessor.sqlite-participant-projection.js";
import type { SessionEntryReadScope } from "./session-accessor.types.js";
import { readSessionActorTransactionState } from "./session-actor-transaction.js";
import { assertCanonicalSqliteSessionKeysCurrent } from "./session-canonical-key.js";
import { captureSessionEntryPublicationSource } from "./session-entry-publication-source.js";
import type { SessionEntrySnapshot } from "./session-entry-snapshots.js";
import { collectSessionEntryLookupKeys } from "./store-entry.js";
import type { InternalSessionEntry, SessionEntry } from "./types.js";

export {
  readSessionEntryCreationTransition,
  retainPreparedSessionGenerationFacts,
  retainPreparedSessionSharingFacts,
} from "./session-accessor.sqlite-entry-cache-publication-state.js";
export {
  isPreparedSessionSharingChange,
  publishSessionEntryPlaceholderInsertion,
  publishSessionEntryWorkerMetadataInvalidation,
  publishSessionSharingMemberChange,
  withSessionEntryCreationPublication,
  runWithSessionEntryCreationPublication,
} from "./session-accessor.sqlite-entry-cache-publication.js";
export { retainSessionEntryWorkerPublication } from "./session-accessor.sqlite-entry-worker-publication.js";
export {
  projectSessionSharingEntry,
  type SessionEntryPlaceholder,
  type SessionEntryReplacementPublication,
  type SessionTranscriptInitializationPublication,
} from "./session-accessor.sqlite-entry-cache.types.js";

type SqliteSessionEntryCacheWriteGeneration = {
  after: number;
  before: number;
};

type SessionEntryCacheUpdate = { sessionKey: string } & (
  | {
      entry: SessionEntry;
      entryJson: string;
      sideMetadata: SessionEntrySideMetadata;
      snapshotEntry?: SessionEntry;
      snapshots?: readonly SessionEntrySnapshot[];
    }
  | { entry?: undefined; entryJson?: never }
);

/** Reuse only complete, current metadata; exact reads still own misses and invalid rows. */
function readCachedExactSessionEntries(
  database: SessionEntryCacheDatabase,
  sessionKeys: readonly string[],
): Map<string, SessionEntry> | undefined {
  const cached = sessionEntryCaches.get(database.db);
  if (!cached || database.db.isTransaction) {
    return undefined;
  }
  const keys = [...new Set(sessionKeys.map(toUSVString))];
  if (keys.some((key) => !cached.entries.has(key))) {
    return undefined;
  }
  const validityToken = cached.validityToken;
  try {
    if (!cacheValidityTokensEqual(validityToken, readSessionEntryCacheValidityToken(database.db))) {
      return undefined;
    }
    const entries = new Map<string, SessionEntry>();
    for (const sessionKey of new Set(sessionKeys)) {
      const key = toUSVString(sessionKey);
      const entry = cached.entries.get(key)!;
      // Mutable reads own each raw key, including nested entry values.
      entries.set(sessionKey, validateDeliveryCanonicalSessionEntry(key, structuredClone(entry)));
    }
    return entries;
  } catch {
    // Cohort conversion/validation failures retain the exact reader's per-key errors.
    sessionEntryCaches.delete(database.db);
    return undefined;
  }
}

/** Decode one admitted physical store without changing exact per-request error isolation. */
export function readExactSessionEntryCandidatesInDatabase(
  database: Pick<OpenClawAgentDatabase, "agentId" | "db" | "path">,
  requests: readonly (readonly string[])[],
  projection: SessionEntryReadScope["projection"] | "delivery",
  options: { validation?: "canonical" } = {},
): Array<Result<ExactSessionEntry[], unknown>> {
  const entries = new Map<string, Result<ExactSessionEntry | undefined, unknown>>();
  const validationKeys = (sessionKey: string) =>
    options.validation === "canonical"
      ? [...new Set([sessionKey, ...collectSessionEntryLookupKeys(sessionKey)])]
      : [sessionKey];
  const keys = [...new Set(requests.flatMap((request) => request.flatMap(validationKeys)))];
  const cachedEntries =
    projection === "list" && options.validation === undefined
      ? readCachedExactSessionEntries(database, keys)
      : undefined;
  let readPrepared: (sessionKey: string) => InternalSessionEntry | undefined;
  if (cachedEntries) {
    readPrepared = (sessionKey) => cachedEntries.get(sessionKey);
  } else {
    const readRows = prepareExactSessionEntryRowReads(
      database,
      keys,
      projection,
      options.validation,
    );
    readPrepared = (sessionKey) => readRows(sessionKey)?.entry;
  }
  const readEntry = (sessionKey: string): Result<ExactSessionEntry | undefined, unknown> => {
    const cached = entries.get(sessionKey);
    if (cached) {
      return cached;
    }
    let result: Result<ExactSessionEntry | undefined, unknown>;
    try {
      const entry = readOpenClawAgentDatabase(database, () => readPrepared(sessionKey)).value;
      result = ok(entry ? { sessionKey, entry } : undefined);
    } catch (error) {
      result = err(error);
    }
    entries.set(sessionKey, result);
    return result;
  };
  return requests.map((sessionKeys) => {
    const matches: ExactSessionEntry[] = [];
    for (const sessionKey of sessionKeys) {
      // Folded candidates guard the exact target; they never become returned aliases.
      for (const candidate of validationKeys(sessionKey)) {
        const checked = readEntry(candidate);
        if (!checked.ok) {
          return err(checked.error);
        }
      }
      const entry = readEntry(sessionKey);
      if (!entry.ok) {
        return err(entry.error);
      }
      if (entry.value) {
        matches.push(entry.value);
      }
    }
    return ok(matches);
  });
}

/** Capture the preimage before a prepared write; settle its generation after commit. */
export function prepareSessionEntryCacheWrite(database: OpenClawAgentDatabase) {
  const before =
    !readSessionActorTransactionState(database) &&
    sessionEntryCaches.has(database.db) &&
    getAdmittedSqliteSchemaFacts(database.db)
      ? readSessionNodesGeneration(database.db)
      : undefined;
  return (): SqliteSessionEntryCacheWriteGeneration | undefined => {
    if (before === undefined || !getAdmittedSqliteSchemaFacts(database.db)) {
      sessionEntryCaches.delete(database.db);
      return undefined;
    }
    return { before, after: readSessionNodesGeneration(database.db) };
  };
}

/** Bracket one accessor-owned row write so its publication cannot hide earlier raw DML. */
export function trackSessionEntryCacheWrite(
  database: OpenClawAgentDatabase,
  write: () => void,
): SqliteSessionEntryCacheWriteGeneration | undefined {
  const complete = prepareSessionEntryCacheWrite(database);
  write();
  return complete();
}

/** The transcript owner certifies only writes that leave node and participant metadata unchanged. */
export function preserveSessionEntryCacheAcrossWrite(
  database: OpenClawAgentDatabase,
  write: () => void,
): void {
  const writeGeneration = trackSessionEntryCacheWrite(database, write);
  if (writeGeneration) {
    publishTrackedCacheUpdate(database, () => {
      const cached = sessionEntryCaches.get(database.db);
      if (cached) {
        advanceSessionEntryCacheGeneration(cached, writeGeneration);
      }
    });
  }
}

export function readSessionEntryCache(
  database: SessionEntryCacheDatabase,
  options: SessionEntryCacheReadOptions,
): SessionEntryCacheSnapshot {
  return runSqliteReadOperationSync(database.db, () => {
    const projection = options.projection;
    const validityToken =
      options.cache &&
      !options.deferParticipants &&
      !options.latest &&
      projection !== "full" &&
      !database.db.isTransaction &&
      getAdmittedSqliteSchemaFacts(database.db)
        ? readSessionEntryCacheValidityToken(database.db)
        : undefined;
    const prepared = assertCanonicalSqliteSessionKeysCurrent(database, projection !== "full");
    if (!validityToken) {
      return loadSessionEntrySnapshot(database, projection, prepared, options.deferParticipants);
    }
    const cached = sessionEntryCaches.get(database.db);
    if (cached && cacheValidityTokensEqual(cached.validityToken, validityToken)) {
      return cached;
    }
    // Only tracked publications identify changed rows. A generation gap can contain
    // same-timestamp or owner-only edits; updated_at cannot validate a partial reload.
    const loaded = loadSessionEntrySnapshot(database, options.projection, prepared);
    for (const entry of loaded.entries.values()) {
      freezeJsonSnapshot(entry);
    }
    const next = { ...loaded, validityToken };
    sessionEntryCaches.set(database.db, next);
    return next;
  });
}

function advanceSessionEntryCacheGeneration(
  cached: SqliteSessionEntryCache,
  writeGeneration: SqliteSessionEntryCacheWriteGeneration,
): void {
  // Advance only across the bracketed row write. A raw write before/after this bracket leaves
  // a generation gap, while sibling writer receipts invalidate other-connection results.
  if (cached.validityToken.sessionNodesGeneration === writeGeneration.before) {
    cached.validityToken = {
      ...cached.validityToken,
      sessionNodesGeneration: writeGeneration.after,
    };
  }
}

function publishSqliteSessionEntryCacheUpsert(
  database: SessionEntryCacheDatabase,
  update: SessionEntryCacheUpdate,
  writeGeneration: SqliteSessionEntryCacheWriteGeneration,
): { sideMetadata: SessionEntrySideMetadata; entry: SessionEntry | undefined } | undefined {
  const owner = sessionEntryCaches.get(database.db);
  if (!owner) {
    return undefined;
  }
  const { sessionKey } = update;
  let sideMetadata: SessionEntrySideMetadata;
  let entry: SessionEntry | undefined;
  try {
    // A tracked entry write leaves participants unchanged. Reuse only facts current
    // before that write; raw DML and sibling writes still force an authoritative read.
    const retained =
      update.entry &&
      owner.validityToken.sessionNodesGeneration === writeGeneration.before &&
      owner.validityToken.siblingWriteRevision !== undefined &&
      owner.validityToken.siblingWriteRevision ===
        readSqliteDatabaseSiblingWriteRevision(database.db)
        ? owner.entries.get(sessionKey)
        : undefined;
    sideMetadata = readSessionEntrySideMetadata(
      database,
      sessionKey,
      retained
        ? { participants: retained.participants, participantCount: retained.participantCount }
        : undefined,
    );
    entry = update.entry
      ? projectSessionEntryCacheUpdate(update.entryJson, sideMetadata)
      : undefined;
  } catch {
    // A failed derived projection must not roll back an authoritative write.
    publishTrackedCacheUpdate(database, () => sessionEntryCaches.delete(database.db));
    return undefined;
  }
  publishTrackedCacheUpdate(database, () => {
    const cached = sessionEntryCaches.get(database.db);
    if (!cached) {
      return;
    }
    // Borrowed cache views are synchronous, so the commit owner can update one
    // row in place without cloning every session map on each active-run write.
    let publishedEntry = entry;
    const currentEntry = cached.entries.get(sessionKey);
    if (!update.entry && currentEntry) {
      // Earlier publications in this transaction may have replaced the entry itself.
      publishedEntry = projectSessionEntryCacheMetadata(currentEntry, sideMetadata);
    }
    if (!publishedEntry) {
      sessionEntryCaches.delete(database.db);
      return;
    }
    if (!cached.entries.has(sessionKey) && !cached.keys.includes(sessionKey)) {
      cached.keys = [...cached.keys, sessionKey].toSorted();
    }
    cached.entries.set(sessionKey, publishedEntry);
    advanceSessionEntryCacheGeneration(cached, writeGeneration);
  });
  return { sideMetadata, entry };
}

export function publishSessionEntryCacheInvalidation(
  database: SessionEntryCacheDatabase & { path: string },
  update: SessionEntryCacheUpdate & {
    previousEntry?: Pick<SessionEntry, "sessionId" | "lifecycleRevision">;
    facts?: SessionRowFacts;
    sharingUnchanged?: boolean;
  },
  writeGeneration?: SqliteSessionEntryCacheWriteGeneration,
): SessionEntry | undefined {
  let facts = update.facts;
  const cached = writeGeneration
    ? publishSqliteSessionEntryCacheUpsert(database, update, writeGeneration)
    : undefined;
  if (!writeGeneration) {
    publishTrackedCacheUpdate(database, () => sessionEntryCaches.delete(database.db));
  }
  if (facts?.kind === "participants" && cached) {
    facts = {
      kind: "participants",
      projection: {
        participants: cached.sideMetadata.participants,
        participantCount: cached.sideMetadata.participantCount,
      },
    };
  }
  // The writer already acquired side-table facts. A cold cache cannot force a host reload.
  const entry = update.entry
    ? (cached?.entry ?? projectSessionEntryCacheUpdate(update.entryJson, update.sideMetadata))
    : undefined;
  const fullEntry =
    update.entry && update.snapshotEntry
      ? projectSessionEntryCacheUpdate(
          update.entryJson,
          cached?.sideMetadata ?? update.sideMetadata,
          update.snapshotEntry,
          update.snapshots,
        )
      : undefined;
  publishSessionSharingEntryChange(database, {
    ...update,
    facts,
    ...(entry ? { entry } : {}),
    fullEntry,
  });
  const identity = findOpenClawAgentDatabaseIdentity(database);
  const sharingChange =
    update.sharingUnchanged || facts?.kind === "unchanged" || facts?.kind === "participants"
      ? "unchanged"
      : "changed";
  emitPreparedSessionSharingChange(
    database,
    update.sessionKey,
    database.agentId,
    facts,
    identity && entry
      ? {
          kind: "metadata",
          sharingChange,
          previous: update.previousEntry && {
            sessionId: update.previousEntry.sessionId,
            lifecycleRevision: update.previousEntry.lifecycleRevision,
          },
          prepared: {
            source: captureSessionEntryPublicationSource(database.db, {
              ...identity,
              ...(writeGeneration ? { revision: writeGeneration.after } : {}),
            }),
            entries: new Map([[update.sessionKey, entry]]),
            ...(fullEntry ? { fullEntries: new Map([[update.sessionKey, fullEntry]]) } : {}),
          },
        }
      : { kind: "marker", sharingChange },
  );
  return fullEntry;
}

/** Refresh participant projections without reloading unchanged session-entry JSON. */
export function publishSessionEntryCacheParticipantUpdate(
  database: OpenClawAgentDatabase,
  sessionKey: string,
  params: {
    writeGeneration: SqliteSessionEntryCacheWriteGeneration | undefined;
    projectionChanged: boolean;
  },
): void {
  const { writeGeneration, projectionChanged } = params;
  if (!projectionChanged) {
    // Count-only contributions retain list facts but invalidate exact participant records.
    if (writeGeneration) {
      publishTrackedCacheUpdate(database, () => {
        const cached = sessionEntryCaches.get(database.db);
        if (cached) {
          advanceSessionEntryCacheGeneration(cached, writeGeneration);
        }
      });
    }
    emitPreparedSessionSharingChange(
      database,
      sessionKey,
      database.agentId,
      { kind: "participants", projectionChanged: false },
      { kind: "marker", sharingChange: "unchanged" },
    );
    return;
  }
  let facts: SessionRowFacts = { kind: "participants" };
  if (!writeGeneration) {
    try {
      facts = {
        kind: "participants",
        projection: readSqliteSessionParticipantProjection(database.db, sessionKey),
      };
    } catch {
      // Invalid derived facts require reconciliation without rolling back the recorded write.
    }
  }
  publishSessionEntryCacheInvalidation(database, { sessionKey, facts }, writeGeneration);
}
