import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type { TranscriptEvent } from "./session-accessor.sqlite-contract.js";
import {
  readTranscriptEventId,
  readTranscriptStorageRows,
  type SqliteTranscriptStorageRow,
} from "./session-accessor.sqlite-read.js";
import { getSessionKysely, type ResolvedTranscriptScope } from "./session-accessor.sqlite-scope.js";
import {
  readTranscriptMutationStateInTransaction,
  rotateTranscriptGenerationInTransaction,
  touchTranscriptMutationInTransaction,
} from "./session-accessor.sqlite-transcript-state.js";
import {
  canonicalizeTranscriptEventMedia,
  insertTranscriptRowsWithoutProjectionInTransaction,
  readEventTimestamp,
  readMessageIdempotencyKey,
  scheduleTranscriptProjectionReconcile,
} from "./session-accessor.sqlite-transcript-store.js";
import {
  prepareIncrementalSuffixIdempotencyMutation,
  type IncrementalSuffixIdempotencyMutation,
} from "./session-accessor.sqlite-transcript-suffix-idempotency.js";
import {
  markSessionTranscriptIndexDirtyInTransaction,
  replaceSessionTranscriptIndexSuffixInTransaction,
  sessionTranscriptIndexNeedsReconcile,
  SYNC_REBUILD_MAX_BYTES,
  SYNC_REBUILD_MAX_ROWS,
  type SessionTranscriptIndexProjection,
} from "./session-transcript-index.js";
import {
  projectTranscriptRetainedDataSql,
  stageRetainedTranscriptData,
} from "./session-transcript-retained-data.js";
import {
  prepareFullTranscriptSuffixMutation,
  prepareTranscriptIndexProjection,
} from "./session-transcript-suffix-projection.js";
import {
  isSessionTranscriptLeafControl,
  parseSessionTranscriptTreeEntry,
} from "./transcript-tree.js";

type SqliteTranscriptSuffixMutationPlan = {
  expectedRows: readonly SqliteTranscriptStorageRow[];
  retainedCustomDataIds?: readonly string[];
  incremental?: {
    expectedMutationAt: number | null;
    projectionWasHealthy: boolean;
    removedMessageIds: readonly string[];
    retainedActiveCount: number;
    suffixIdentityKeys: readonly (readonly [string, string | null])[];
    replacementByIdempotencyKey: readonly (readonly [string, string])[];
  };
  next: readonly TranscriptEvent[];
  nextCreatedAt: readonly number[];
  nextProjection: SessionTranscriptIndexProjection;
  prefixLength: number;
  previousProjection?: SessionTranscriptIndexProjection;
  startSeq: number;
};

// Preserve the raw suffix mutation when an exact incremental projection update is unsafe.
function verifyIncrementalPlanningFence(
  database: OpenClawAgentDatabase,
  resolved: ResolvedTranscriptScope,
  expectedMutationAt: number | null,
): void {
  if (
    readTranscriptMutationStateInTransaction(database, resolved.sessionId).updatedAt !==
    expectedMutationAt
  ) {
    throw new Error(
      `SQLite transcript changed while planning suffix removal for ${resolved.sessionId}`,
    );
  }
}

function prepareReconciledIncrementalSuffixMutation(params: {
  database: OpenClawAgentDatabase;
  expectedMutationAt: number | null;
  expectedRows: readonly SqliteTranscriptStorageRow[];
  idempotencyMutation: IncrementalSuffixIdempotencyMutation;
  next: readonly TranscriptEvent[];
  nextCreatedAt: readonly number[];
  resolved: ResolvedTranscriptScope;
  startSeq: number;
}): SqliteTranscriptSuffixMutationPlan {
  verifyIncrementalPlanningFence(params.database, params.resolved, params.expectedMutationAt);
  return {
    expectedRows: params.expectedRows,
    incremental: {
      expectedMutationAt: params.expectedMutationAt,
      projectionWasHealthy: false,
      removedMessageIds: [],
      retainedActiveCount: 0,
      ...params.idempotencyMutation,
    },
    next: params.next,
    nextCreatedAt: params.nextCreatedAt,
    nextProjection: {
      activeMessageCount: 0,
      activeRows: [],
      indexedSeq: params.startSeq - 1,
      leafEventId: null,
    },
    prefixLength: 0,
    startSeq: params.startSeq,
  };
}

function prepareIncrementalTranscriptSuffixMutation(
  database: OpenClawAgentDatabase,
  resolved: ResolvedTranscriptScope,
  expectedEvents: readonly TranscriptEvent[],
  nextEvents: readonly TranscriptEvent[],
  persistedPrefixLength: number,
  expectedMutationAt?: number | null,
  eventsStartAtPersistedPrefix = false,
  retainedCustomDataIds: readonly string[] = [],
): SqliteTranscriptSuffixMutationPlan {
  const expectedTail = (
    eventsStartAtPersistedPrefix ? expectedEvents : expectedEvents.slice(persistedPrefixLength)
  ).map(canonicalizeTranscriptEventMedia);
  const nextTail = (
    eventsStartAtPersistedPrefix ? nextEvents : nextEvents.slice(persistedPrefixLength)
  ).map(canonicalizeTranscriptEventMedia);
  if (expectedTail.length > SYNC_REBUILD_MAX_ROWS || nextTail.length > SYNC_REBUILD_MAX_ROWS) {
    throw new Error(
      `Transcript suffix exceeds synchronous planning row limit for ${resolved.sessionId}`,
    );
  }
  const expectedJson = expectedTail.map((event) => JSON.stringify(event));
  const nextJson = nextTail.map((event) => JSON.stringify(event));
  let bytes = 0;
  for (const json of [...expectedJson, ...nextJson]) {
    bytes += Buffer.byteLength(json, "utf8");
    if (bytes > SYNC_REBUILD_MAX_BYTES) {
      throw new Error(
        `Transcript suffix exceeds synchronous planning byte limit for ${resolved.sessionId}`,
      );
    }
  }
  let localPrefixLength = 0;
  while (
    localPrefixLength < expectedJson.length &&
    localPrefixLength < nextJson.length &&
    expectedJson[localPrefixLength] === nextJson[localPrefixLength]
  ) {
    localPrefixLength += 1;
  }
  if (nextTail.length > expectedTail.length) {
    throw new Error(
      `Transcript mutation is not a bounded suffix removal for ${resolved.sessionId}`,
    );
  }

  const currentMutationAt = readTranscriptMutationStateInTransaction(
    database,
    resolved.sessionId,
  ).updatedAt;
  if (expectedMutationAt !== undefined && currentMutationAt !== expectedMutationAt) {
    throw new Error(
      `SQLite transcript changed while preparing suffix removal for ${resolved.sessionId}`,
    );
  }
  const db = getSessionKysely(database.db);
  const storedTail = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("transcript_events")
      .select((eb) => [
        "created_at",
        projectTranscriptRetainedDataSql(eb.ref("event_json"), retainedCustomDataIds).as(
          "event_json",
        ),
        "seq",
      ])
      .where("session_id", "=", resolved.sessionId)
      .where("seq", ">=", persistedPrefixLength)
      .orderBy("seq", "asc")
      .limit(expectedTail.length + 1),
  ).rows.map((row) => ({ createdAt: row.created_at, eventJson: row.event_json, seq: row.seq }));
  if (
    storedTail.length !== expectedJson.length ||
    storedTail.some((row, index) => row.eventJson !== expectedJson[index])
  ) {
    throw new Error(
      `SQLite transcript changed while preparing suffix removal for ${resolved.sessionId}`,
    );
  }

  const expectedRows = storedTail.slice(localPrefixLength);
  const next = nextTail.slice(localPrefixLength);
  const startSeq =
    expectedRows[0]?.seq ?? (storedTail.at(-1)?.seq ?? persistedPrefixLength - 1) + 1;
  const storedCreatedAtByEventId = new Map(
    expectedTail.flatMap((event, index) => {
      const eventId = readTranscriptEventId(event);
      const createdAt = storedTail[index]?.createdAt;
      return eventId && createdAt !== undefined ? [[eventId, createdAt] as const] : [];
    }),
  );
  const nextCreatedAt = next.map((event) => {
    const eventId = readTranscriptEventId(event);
    return (
      (eventId ? storedCreatedAtByEventId.get(eventId) : undefined) ??
      readEventTimestamp(event) ??
      Date.now()
    );
  });
  const idempotencyMutation = prepareIncrementalSuffixIdempotencyMutation({
    database,
    expectedRows,
    next,
    resolved,
    startSeq,
  });
  const projectionWasHealthy = !sessionTranscriptIndexNeedsReconcile(
    database.db,
    resolved.sessionId,
  );
  if (!projectionWasHealthy) {
    return prepareReconciledIncrementalSuffixMutation({
      database,
      expectedMutationAt: currentMutationAt,
      expectedRows,
      idempotencyMutation,
      next,
      nextCreatedAt,
      resolved,
      startSeq,
    });
  }
  const anchorId =
    parseSessionTranscriptTreeEntry(next[0])?.parentId ??
    parseSessionTranscriptTreeEntry(expectedTail[localPrefixLength])?.parentId ??
    null;
  const anchor = anchorId
    ? executeSqliteQueryTakeFirstSync(
        database.db,
        db
          .selectFrom("transcript_event_identities as identity")
          .innerJoin("session_transcript_active_events as active", (join) =>
            join
              .onRef("active.session_id", "=", "identity.session_id")
              .onRef("active.event_seq", "=", "identity.seq"),
          )
          .select(["active.active_position", "identity.event_id"])
          .where("identity.session_id", "=", resolved.sessionId)
          .where("identity.event_id", "=", anchorId),
      )
    : undefined;
  const knownRelativeIds = new Set(anchorId ? [anchorId] : []);
  const suffixRedirectsOutsideProjection = next.some((event) => {
    const treeEntry = parseSessionTranscriptTreeEntry(event);
    if (!treeEntry) {
      return false;
    }
    const redirectsOutside =
      treeEntry.parentId === null ||
      !knownRelativeIds.has(treeEntry.parentId) ||
      (isSessionTranscriptLeafControl(event) &&
        treeEntry.appendParentId !== null &&
        !knownRelativeIds.has(treeEntry.appendParentId));
    knownRelativeIds.add(treeEntry.id);
    return redirectsOutside;
  });
  const changedEventWasActive = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("session_transcript_active_events")
      .select("event_seq")
      .where("session_id", "=", resolved.sessionId)
      .where("event_seq", "=", startSeq),
  );
  if (!changedEventWasActive || !anchorId || !anchor || suffixRedirectsOutsideProjection) {
    // Root-level, inactive, and externally redirected branches can expose durable history outside
    // the prepared suffix.
    // Rebuild their derived rows after the fenced mutation instead of publishing an incomplete view.
    return prepareReconciledIncrementalSuffixMutation({
      database,
      expectedMutationAt: currentMutationAt,
      expectedRows,
      idempotencyMutation,
      next,
      nextCreatedAt,
      resolved,
      startSeq,
    });
  }
  const retainedActiveCount = anchor.active_position + 1;
  const activeSuffixRows = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("transcript_event_identities as identity")
      .innerJoin("session_transcript_active_events as active", (join) =>
        join
          .onRef("active.session_id", "=", "identity.session_id")
          .onRef("active.event_seq", "=", "identity.seq"),
      )
      .select(["active.message_position", "identity.event_id"])
      .where("identity.session_id", "=", resolved.sessionId)
      .where("active.active_position", ">=", retainedActiveCount)
      .limit(SYNC_REBUILD_MAX_ROWS + 1),
  ).rows;
  if (activeSuffixRows.length > SYNC_REBUILD_MAX_ROWS) {
    throw new Error(
      `Transcript active suffix exceeds synchronous planning row limit for ${resolved.sessionId}`,
    );
  }
  const removedMessageIds = activeSuffixRows.flatMap((row) =>
    row.message_position === null ? [] : [row.event_id],
  );
  const retainedMessagePosition = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("session_transcript_active_events")
      .select("message_position")
      .where("session_id", "=", resolved.sessionId)
      .where("active_position", "<", retainedActiveCount)
      .where("message_position", "is not", null)
      .orderBy("active_position", "desc")
      .limit(1),
  )?.message_position;
  const retainedMessageCount =
    retainedMessagePosition === null || retainedMessagePosition === undefined
      ? 0
      : retainedMessagePosition + 1;
  const syntheticAnchor = { type: "custom", id: anchorId, parentId: null };
  const projectionEvents = [syntheticAnchor, ...next];
  const projectionSeqs = projectionEvents.map((_event, index) => startSeq + index - 1);
  const projectionCreatedAt = [Date.now(), ...nextCreatedAt];
  const relativeProjection = prepareTranscriptIndexProjection(
    projectionEvents,
    projectionSeqs,
    projectionCreatedAt,
  );
  const activeRows: SessionTranscriptIndexProjection["activeRows"] = [];
  for (const row of relativeProjection.activeRows) {
    if (row.eventSeq < startSeq) {
      continue;
    }
    activeRows.push({
      ...row,
      activePosition: retainedActiveCount + activeRows.length,
      messagePosition:
        row.messagePosition === null ? null : retainedMessageCount + row.messagePosition,
    });
  }
  const addedMessages = activeRows.filter((row) => row.messagePosition !== null).length;
  verifyIncrementalPlanningFence(database, resolved, currentMutationAt);
  return {
    expectedRows,
    incremental: {
      expectedMutationAt: currentMutationAt,
      projectionWasHealthy,
      removedMessageIds,
      retainedActiveCount,
      ...idempotencyMutation,
    },
    next,
    nextCreatedAt,
    nextProjection: {
      activeMessageCount: retainedMessageCount + addedMessages,
      activeRows,
      indexedSeq: next.length > 0 ? startSeq + next.length - 1 : startSeq - 1,
      leafEventId: relativeProjection.leafEventId,
    },
    prefixLength: 0,
    startSeq,
  };
}

/** Plans bounded suffix work before the synchronous SQLite write transaction. */
export function prepareSqliteTranscriptSuffixMutation(
  database: OpenClawAgentDatabase,
  resolved: ResolvedTranscriptScope,
  expectedEvents: readonly TranscriptEvent[],
  nextEvents: readonly TranscriptEvent[],
  persistedPrefixLength = 0,
  expectedMutationAt?: number | null,
  eventsStartAtPersistedPrefix = false,
  retainedCustomDataIds: readonly string[] = [],
): SqliteTranscriptSuffixMutationPlan {
  if (persistedPrefixLength > 0 || eventsStartAtPersistedPrefix) {
    const plan = prepareIncrementalTranscriptSuffixMutation(
      database,
      resolved,
      expectedEvents,
      nextEvents,
      persistedPrefixLength,
      expectedMutationAt,
      eventsStartAtPersistedPrefix,
      retainedCustomDataIds,
    );
    return { ...plan, retainedCustomDataIds };
  }
  return prepareFullTranscriptSuffixMutation(database, resolved, expectedEvents, nextEvents);
}

/** Mutates an exact transcript suffix while retaining a healthy materialized projection. */
export function replaceSqliteTranscriptSuffixInTransaction(
  database: OpenClawAgentDatabase,
  resolved: ResolvedTranscriptScope,
  plan: SqliteTranscriptSuffixMutationPlan,
): void {
  const db = getSessionKysely(database.db);
  if (
    plan.incremental &&
    readTranscriptMutationStateInTransaction(database, resolved.sessionId).updatedAt !==
      plan.incremental.expectedMutationAt
  ) {
    throw new Error(
      `SQLite transcript changed while preparing suffix removal for ${resolved.sessionId}`,
    );
  }
  const retainedCustomDataIds = plan.retainedCustomDataIds ?? [];
  const storedRows = plan.incremental
    ? executeSqliteQuerySync(
        database.db,
        db
          .selectFrom("transcript_events")
          .select((eb) => [
            "created_at",
            projectTranscriptRetainedDataSql(eb.ref("event_json"), retainedCustomDataIds).as(
              "event_json",
            ),
            "seq",
          ])
          .where("session_id", "=", resolved.sessionId)
          .where("seq", ">=", plan.startSeq)
          .orderBy("seq", "asc")
          .limit(plan.expectedRows.length + 1),
      ).rows.map((row) => ({ createdAt: row.created_at, eventJson: row.event_json, seq: row.seq }))
    : readTranscriptStorageRows(database, resolved.sessionId);
  if (
    storedRows.length !== plan.expectedRows.length ||
    storedRows.some((row, index) => {
      const expected = plan.expectedRows[index];
      return (
        expected === undefined ||
        row.seq !== expected.seq ||
        row.createdAt !== expected.createdAt ||
        row.eventJson !== expected.eventJson
      );
    })
  ) {
    throw new Error(
      `SQLite transcript changed while preparing suffix removal for ${resolved.sessionId}`,
    );
  }
  if (plan.expectedRows.length === 0 && plan.next.length === 0) {
    return;
  }

  const projectionIsHealthy =
    plan.incremental?.projectionWasHealthy !== false &&
    !sessionTranscriptIndexNeedsReconcile(database.db, resolved.sessionId);
  const suffixIdentityKeys = new Map(
    plan.incremental?.suffixIdentityKeys ??
      executeSqliteQuerySync(
        database.db,
        db
          .selectFrom("transcript_event_identities")
          .select(["event_id", "message_idempotency_key"])
          .where("session_id", "=", resolved.sessionId)
          .where("seq", ">=", plan.startSeq),
      ).rows.map((row) => [row.event_id, row.message_idempotency_key] as const),
  );
  const insertEvents = plan.incremental ? plan.next : plan.next.slice(plan.prefixLength);
  const insertCreatedAt = plan.incremental
    ? plan.nextCreatedAt
    : plan.nextCreatedAt.slice(plan.prefixLength);
  const retainedIdempotencyKeys = new Set(
    insertEvents.flatMap((event) => {
      const eventId = readTranscriptEventId(event);
      const storedKey = eventId ? suffixIdentityKeys.get(eventId) : undefined;
      const nextKey = isRecord(event) ? readMessageIdempotencyKey(event.message) : null;
      return storedKey && storedKey === nextKey ? [storedKey] : [];
    }),
  );

  const stagedData = stageRetainedTranscriptData(
    database,
    resolved.sessionId,
    plan.expectedRows,
    insertEvents,
    retainedCustomDataIds,
  );
  executeSqliteQuerySync(
    database.db,
    db
      .deleteFrom("transcript_event_identities")
      .where("session_id", "=", resolved.sessionId)
      .where("seq", ">=", plan.startSeq),
  );
  executeSqliteQuerySync(
    database.db,
    db
      .deleteFrom("transcript_events")
      .where("session_id", "=", resolved.sessionId)
      .where("seq", ">=", plan.startSeq)
      .$if(stagedData !== undefined, (query) => query.where("seq", "<", stagedData!.startSeq)),
  );
  insertTranscriptRowsWithoutProjectionInTransaction(
    database,
    resolved.sessionId,
    insertEvents.map((event, index) => {
      const seq = plan.startSeq + index;
      const createdAt = insertCreatedAt[index] ?? Date.now();
      const eventId = readTranscriptEventId(event);
      const storedKey = eventId ? suffixIdentityKeys.get(eventId) : undefined;
      const nextKey = isRecord(event) ? readMessageIdempotencyKey(event.message) : null;
      const storedEventSeq = stagedData?.sources.get(index);
      const row: {
        event: TranscriptEvent;
        seq: number;
        createdAt: number;
        storedEventSeq?: number;
        messageIdempotencyKey?: string;
      } = { event, seq, createdAt };
      if (storedEventSeq !== undefined) {
        row.storedEventSeq = storedEventSeq;
      }
      if (storedKey && storedKey === nextKey) {
        row.messageIdempotencyKey = storedKey;
      }
      return row;
    }),
    retainedIdempotencyKeys,
  );
  if (stagedData) {
    executeSqliteQuerySync(
      database.db,
      db
        .deleteFrom("transcript_events")
        .where("session_id", "=", resolved.sessionId)
        .where("seq", ">=", stagedData.startSeq),
    );
  }

  const removedIdempotencyKeys = new Set(
    [...suffixIdentityKeys.values()].filter(
      (key): key is string => key !== null && !retainedIdempotencyKeys.has(key),
    ),
  );
  const replacementByIdempotencyKey = plan.incremental
    ? new Map(plan.incremental.replacementByIdempotencyKey)
    : new Map<string, string>();
  if (!plan.incremental && removedIdempotencyKeys.size > 0) {
    const unownedPrefixRows = executeSqliteQuerySync(
      database.db,
      db
        .selectFrom("transcript_event_identities as identity")
        .innerJoin("transcript_events as event", (join) =>
          join
            .onRef("event.session_id", "=", "identity.session_id")
            .onRef("event.seq", "=", "identity.seq"),
        )
        .select(["event.event_json", "identity.event_id"])
        .where("identity.session_id", "=", resolved.sessionId)
        .where("identity.seq", "<", plan.startSeq)
        .where("identity.message_idempotency_key", "is", null)
        .orderBy("identity.seq", "desc"),
    ).rows;
    for (const row of unownedPrefixRows) {
      // SAFETY: persisted transcript rows are JSON objects written by the canonical event store.
      const event = JSON.parse(row.event_json) as { message?: unknown };
      const key = readMessageIdempotencyKey(event.message);
      if (key && removedIdempotencyKeys.has(key) && !replacementByIdempotencyKey.has(key)) {
        replacementByIdempotencyKey.set(key, row.event_id);
      }
    }
  }
  for (const key of removedIdempotencyKeys) {
    const currentOwner = executeSqliteQueryTakeFirstSync(
      database.db,
      db
        .selectFrom("transcript_event_identities")
        .select("event_id")
        .where("session_id", "=", resolved.sessionId)
        .where("message_idempotency_key", "=", key)
        .limit(1),
    );
    const replacementEventId = replacementByIdempotencyKey.get(key);
    if (!currentOwner && replacementEventId) {
      executeSqliteQuerySync(
        database.db,
        db
          .updateTable("transcript_event_identities")
          .set({ message_idempotency_key: key })
          .where("session_id", "=", resolved.sessionId)
          .where("event_id", "=", replacementEventId),
      );
    }
  }

  // Destructive suffix rewrites may reuse removed sequence positions. Rotate the raw and visible
  // cursor generation in the same transaction so a resumed reader cannot silently skip replacements.
  rotateTranscriptGenerationInTransaction(database, resolved.sessionId);
  if (projectionIsHealthy) {
    replaceSessionTranscriptIndexSuffixInTransaction(database.db, resolved.sessionId, {
      unchangedBeforeSeq: plan.startSeq,
      ...(plan.previousProjection ? { previous: plan.previousProjection } : {}),
      next: plan.nextProjection,
      ...(plan.incremental
        ? {
            removedMessageIds: plan.incremental.removedMessageIds,
            retainedActiveCount: plan.incremental.retainedActiveCount,
          }
        : {}),
    });
  } else {
    markSessionTranscriptIndexDirtyInTransaction(database.db, resolved.sessionId);
    scheduleTranscriptProjectionReconcile(database, resolved.sessionId, true, {});
  }
  touchTranscriptMutationInTransaction(database, resolved.sessionId);
}
