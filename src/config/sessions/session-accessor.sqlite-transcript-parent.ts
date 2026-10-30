import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { sql } from "kysely";
import {
  jsonObjectFieldsForScan,
  jsonScannedValue,
} from "../../infra/database-engine/json-values.js";
import {
  executeSqliteQueryTakeFirstSync,
  iterateSqliteQuerySync,
} from "../../infra/kysely-sync.js";
import type { UserTurnTranscriptAdmissionReceipt } from "../../sessions/user-turn-transcript.types.js";
import {
  readJsonPredicateScalar,
  scanJsonObjectFields,
} from "../../state/json-predicate-fields.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type {
  TranscriptEvent,
  TranscriptEventAppendOptions,
  TranscriptMessageAppendOptions,
} from "./session-accessor.sqlite-contract.js";
import { selectActiveTranscriptEventRows } from "./session-accessor.sqlite-projection-read.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import { selectTranscriptAppendParentIdentity } from "./session-accessor.sqlite-transcript-state.queries.js";
import { readSessionActorTransactionState } from "./session-actor-transaction.js";
import { projectTranscriptNavigationSql } from "./session-model-context-projection.js";
import { sessionTranscriptIndexNeedsReconcile } from "./session-transcript-index.js";
import { transcriptEventReadBytesSql } from "./session-transcript-read-bytes.js";
import {
  PREPARED_ASSISTANT_MAX_NEWER_MESSAGES,
  PREPARED_ASSISTANT_MAX_NEWER_BYTES,
  PREPARED_ASSISTANT_MAX_ANCESTORS,
  preparedAssistantMessagesPreserveTurn,
  resolveTranscriptAppendParent,
} from "./transcript-append-parent.js";
import { transcriptEventNavigationSql } from "./transcript-payload.js";
import { assertTranscriptNavigationValid } from "./transcript-predicate-fields.js";
import {
  isSessionTranscriptLeafControl,
  parseSessionTranscriptTreeEntry,
  resolveSessionTranscriptActiveLeafEntryId,
  scanSessionTranscriptTree,
  selectSessionTranscriptTreePathNodes,
} from "./transcript-tree.js";

/** Validates a prepared assistant from bounded indexed message metadata. */
export function canRebasePreparedAssistantInTransaction(
  database: Pick<OpenClawAgentDatabase, "db" | "path">,
  sessionId: string,
  preparedParentId: string | null,
  admittedUserId?: string,
  questionAnswers: readonly UserTurnTranscriptAdmissionReceipt[] = [],
): boolean {
  const tailId = readActiveTranscriptAppendParentId(database, sessionId);
  if (tailId !== preparedParentId) {
    if (
      tailId === null ||
      !transcriptEntryIsAncestor(database, sessionId, tailId, preparedParentId)
    ) {
      return false;
    }
  }
  if (
    admittedUserId &&
    tailId !== admittedUserId &&
    (tailId === null || !transcriptEntryIsAncestor(database, sessionId, tailId, admittedUserId))
  ) {
    return false;
  }
  const db = getSessionKysely(database.db);
  const preparedParent =
    preparedParentId === null
      ? undefined
      : readTranscriptIdentityInTransaction(database, sessionId, preparedParentId);
  if (preparedParentId !== null && !preparedParent) {
    return false;
  }
  const admitted = admittedUserId
    ? admittedUserId === preparedParentId
      ? preparedParent
      : readTranscriptIdentityInTransaction(database, sessionId, admittedUserId)
    : undefined;
  if (admittedUserId && !admitted) {
    return false;
  }
  const actor = readSessionActorTransactionState(database, { sessionId });
  const admittedIsNewer = admitted !== undefined && admitted.seq > (preparedParent?.seq ?? -1);
  if (
    actor?.transcript.complete &&
    ![...actor.transcript.identities.values()].some(
      (identity) => identity.event_type === "message" && identity.seq > (preparedParent?.seq ?? -1),
    )
  ) {
    return !admittedIsNewer;
  }
  const newerMessageMetadata = Array.from(
    iterateSqliteQuerySync(
      database.db,
      db
        .selectFrom("transcript_event_identities as identity")
        .innerJoin("transcript_events as event", (join) =>
          join
            .onRef("event.session_id", "=", "identity.session_id")
            .onRef("event.seq", "=", "identity.seq"),
        )
        .select([
          "identity.event_id",
          "identity.seq",
          /* kysely-allow-raw: bound newer-message validation before hydrating event JSON. */
          transcriptEventReadBytesSql("event").as("serialized_bytes"),
        ])
        .where("identity.session_id", "=", sessionId)
        .where("identity.event_type", "=", "message")
        .where("identity.seq", ">", preparedParent?.seq ?? -1)
        .orderBy("identity.seq", "asc")
        .limit(PREPARED_ASSISTANT_MAX_NEWER_MESSAGES + 1),
    ),
  );
  if (
    newerMessageMetadata.length > PREPARED_ASSISTANT_MAX_NEWER_MESSAGES ||
    newerMessageMetadata.reduce((sum, row) => sum + row.serialized_bytes, 0) >
      PREPARED_ASSISTANT_MAX_NEWER_BYTES
  ) {
    return false;
  }
  if (admittedIsNewer && !newerMessageMetadata.some((row) => row.event_id === admittedUserId)) {
    return false;
  }
  if (newerMessageMetadata.length === 0) {
    return !admittedIsNewer;
  }
  const newerRoles = Array.from(
    iterateSqliteQuerySync(
      database.db,
      db
        .selectFrom("transcript_event_identities as identity")
        .innerJoin("transcript_events as event", (join) =>
          join
            .onRef("event.session_id", "=", "identity.session_id")
            .onRef("event.seq", "=", "identity.seq"),
        )
        .leftJoin("session_transcript_active_events as active", (join) =>
          join
            .onRef("active.session_id", "=", "identity.session_id")
            .onRef("active.event_seq", "=", "identity.seq"),
        )
        .leftJoin("transcript_rewrite_watermarks as rewrite", (join) =>
          join.onRef("rewrite.session_id", "=", "identity.session_id"),
        )
        .select([
          "identity.event_id",
          "identity.seq",
          "identity.parent_id",
          "active.message_position",
          "rewrite.generation",
          jsonObjectFieldsForScan(database.db, transcriptEventNavigationSql(database.db, "event"), {
            message: {
              role: true,
              excludeFromContext: true,
              __openclaw: { contextFreeCommand: true },
              provenance: { kind: true, sourceChannel: true },
            },
          }).as("message_json"),
        ])
        .where("identity.session_id", "=", sessionId)
        .where("identity.seq", ">=", newerMessageMetadata[0]!.seq)
        .where("identity.seq", "<=", newerMessageMetadata.at(-1)!.seq)
        .where("identity.event_type", "=", "message")
        .orderBy("identity.seq", "asc")
        .limit(PREPARED_ASSISTANT_MAX_NEWER_MESSAGES),
    ),
  );
  const newerFacts = newerRoles.map((row) => {
    const event = scanJsonObjectFields(row.message_json, ["message"]);
    // SQLite's depth limit does not make a valid navigation envelope corrupt.
    assertTranscriptNavigationValid(event.valid ? 1 : 0);
    const message = event.first.get("message");
    const fields = scanJsonObjectFields(message?.kind === "object" ? message.text : "{}", [
      "role",
      "excludeFromContext",
      "__openclaw",
      "provenance",
    ]).first;
    const internal = fields.get("__openclaw");
    const command = scanJsonObjectFields(internal?.kind === "object" ? internal.text : "{}", [
      "contextFreeCommand",
    ]).first.get("contextFreeCommand");
    const provenance = fields.get("provenance");
    const source = scanJsonObjectFields(provenance?.kind === "object" ? provenance.text : "{}", [
      "kind",
      "sourceChannel",
    ]).first;
    return {
      event_id: row.event_id,
      seq: row.seq,
      parent_id: row.parent_id,
      message_position: row.message_position,
      generation: row.generation,
      message_role: jsonScannedValue(fields.get("role")),
      context_free_command:
        readJsonPredicateScalar(fields.get("excludeFromContext")) === true &&
        readJsonPredicateScalar(command) === true
          ? 1
          : 0,
      provenance_kind: jsonScannedValue(source.get("kind")),
      provenance_source_channel: jsonScannedValue(source.get("sourceChannel")),
    };
  });
  return preparedAssistantMessagesPreserveTurn(newerFacts, admittedUserId, (row) => {
    const answer = questionAnswers.find((input) => input.entryId === row.event_id);
    return (
      answer !== undefined &&
      answer.rawSeq === row.seq &&
      answer.effectiveParentId === row.parent_id &&
      answer.activeMessagePosition === row.message_position &&
      answer.generation === row.generation
    );
  });
}

export function resolveTranscriptEventAppendParent(
  database: Pick<OpenClawAgentDatabase, "db" | "path">,
  sessionId: string,
  event: TranscriptEvent,
  options: TranscriptEventAppendOptions,
): TranscriptEvent {
  if (options.appendIntent !== "active-branch" || !isRecord(event) || !("parentId" in event)) {
    return event;
  }
  const parentId = event.parentId;
  if (parentId !== null && typeof parentId !== "string") {
    return event;
  }
  const effectiveParentId = resolveTranscriptMessageAppendParent(database, sessionId, {
    appendIntent: "active-branch",
    parentId,
  });
  return effectiveParentId === parentId ? event : { ...event, parentId: effectiveParentId };
}

export function resolveTranscriptMessageAppendParent<TMessage>(
  database: Pick<OpenClawAgentDatabase, "db" | "path">,
  sessionId: string,
  options: Pick<TranscriptMessageAppendOptions<TMessage>, "appendIntent" | "parentId">,
  prepared?: TranscriptAppendParentPreparation,
): string | null {
  const tailId = readActiveTranscriptAppendParentId(database, sessionId, prepared);
  return resolveTranscriptAppendParent({
    tailId,
    parentId: options.parentId,
    appendIntent: options.appendIntent,
    isAncestor: (leafId, candidateId) =>
      transcriptEntryIsAncestor(database, sessionId, leafId, candidateId),
  });
}

export type TranscriptAppendParentPreparation = {
  latest:
    | Awaited<
        ReturnType<ReturnType<typeof selectTranscriptAppendParentIdentity>["execute"]>
      >[number]
    | null;
};

/** Checks the durable tree directly when the materialized active-path projection is dirty. */
export function isTranscriptEntryOnActivePathInTransaction(
  database: Pick<OpenClawAgentDatabase, "db" | "path">,
  sessionId: string,
  entryId: string,
): boolean {
  const tree = scanSessionTranscriptTree(readTranscriptNavigationEvents(database, sessionId));
  return selectSessionTranscriptTreePathNodes(tree, tree.leafId).some(
    (node) => node.id === entryId,
  );
}

function transcriptEntryIsAncestor(
  database: Pick<OpenClawAgentDatabase, "db" | "path">,
  sessionId: string,
  leafId: string,
  candidateId: string | null,
): boolean {
  const actor = readSessionActorTransactionState(database, { sessionId });
  if (actor) {
    let current = actor.transcript.identities.get(leafId);
    for (let depth = 0; current && depth < PREPARED_ASSISTANT_MAX_ANCESTORS; depth++) {
      if (current.parent_id === candidateId) {
        return true;
      }
      if (current.parent_id === null) {
        return false;
      }
      current = actor.transcript.identities.get(current.parent_id);
    }
    if (current || actor.transcript.complete) {
      return false;
    }
  }
  const db = getSessionKysely(database.db);
  // Bound ancestry work even for malformed cycles or very deep metadata chains.
  // Keep dangling and null parents in the walk: they can be the requested ancestor.
  const ancestor = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .withRecursive("transcript_ancestors", (query) =>
        query
          .selectFrom("transcript_event_identities")
          .select([
            "parent_id",
            /* kysely-allow-raw: seed the bounded recursive ancestry depth. */
            sql<number>`1`.as("depth"),
          ])
          .where("session_id", "=", sessionId)
          .where("event_id", "=", leafId)
          .unionAll(
            query
              .selectFrom("transcript_event_identities as ti")
              .innerJoin("transcript_ancestors as ancestor", "ti.event_id", "ancestor.parent_id")
              .select([
                "ti.parent_id",
                /* kysely-allow-raw: increment the bounded recursive ancestry depth. */
                sql<number>`ancestor.depth + 1`.as("depth"),
              ])
              .where("ti.session_id", "=", sessionId)
              .where("ancestor.depth", "<", PREPARED_ASSISTANT_MAX_ANCESTORS),
          ),
      )
      .selectFrom("transcript_ancestors")
      .select("parent_id")
      .where("parent_id", candidateId === null ? "is" : "=", candidateId)
      .limit(1),
  );
  return ancestor?.parent_id === candidateId;
}

/** Selects visible identity inside the append transaction, independently of the raw side cursor. */
export function readTranscriptVisibleTailEntryIdInTransaction(
  database: Pick<OpenClawAgentDatabase, "db" | "path">,
  sessionId: string,
  messageId: string,
): string | null {
  const actor = readSessionActorTransactionState(database, { sessionId });
  if (actor?.transcript.complete) {
    const tree = scanSessionTranscriptTree(actor.transcript.navigation);
    return selectSessionTranscriptTreePathNodes(tree, tree.leafId).at(-1)?.id ?? null;
  }
  const db = getSessionKysely(database.db);
  const resolveFromNavigation = () => {
    const tree = scanSessionTranscriptTree(readTranscriptNavigationEvents(database, sessionId));
    return selectSessionTranscriptTreePathNodes(tree, tree.leafId).at(-1)?.id ?? null;
  };
  if (!sessionTranscriptIndexNeedsReconcile(database.db, sessionId)) {
    const tail = executeSqliteQueryTakeFirstSync(
      database.db,
      selectActiveTranscriptEventRows(database)
        .select(
          projectTranscriptNavigationSql(
            database.db,
            transcriptEventNavigationSql(database.db, "event"),
          ).as("event_json"),
        )
        .where("active.session_id", "=", sessionId)
        .orderBy("active.active_position", "desc")
        .limit(1),
    );
    return tail
      ? (resolveSessionTranscriptActiveLeafEntryId([JSON.parse(tail.event_json)]) ?? null)
      : null;
  }

  const message = readTranscriptIdentityInTransaction(database, sessionId, messageId);
  if (!message) {
    return resolveFromNavigation();
  }
  let leafId: string | null = null;
  let first = true;
  let needsPrefix = false;
  const navigation = iterateSqliteQuerySync(
    database.db,
    db
      .selectFrom("transcript_events")
      .select(
        projectTranscriptNavigationSql(database.db, transcriptEventNavigationSql(database.db)).as(
          "event_json",
        ),
      )
      .where("session_id", "=", sessionId)
      .where("seq", ">=", message.seq)
      .orderBy("seq", "asc"),
  );
  for (const row of navigation) {
    const event: unknown = JSON.parse(row.event_json);
    // Controls can reference an earlier branch or cross a reset. Their complete
    // prefix belongs to the canonical tree resolver, not a second control policy.
    if (isSessionTranscriptLeafControl(event)) {
      needsPrefix = true;
      break;
    }
    const selected = resolveSessionTranscriptActiveLeafEntryId([event]);
    if (first && selected !== messageId) {
      needsPrefix = true;
      break;
    }
    first = false;
    if (selected !== undefined) {
      leafId = selected;
    }
  }
  return needsPrefix || first ? resolveFromNavigation() : leafId;
}

function readActiveTranscriptAppendParentId(
  database: Pick<OpenClawAgentDatabase, "db" | "path">,
  sessionId: string,
  prepared?: TranscriptAppendParentPreparation,
): string | null {
  const actor = readSessionActorTransactionState(database, { sessionId });
  if (actor?.transcript.complete) {
    return scanSessionTranscriptTree(actor.transcript.navigation).appendParentId;
  }
  const db = getSessionKysely(database.db);
  const retainedIdentity = actor && [...actor.transcript.identities.values()].at(-1);
  const retainedNavigation =
    retainedIdentity &&
    actor?.transcript.navigation.findLast((event) => event.seq === retainedIdentity.seq);
  const latest = retainedNavigation
    ? undefined
    : prepared && !actor
      ? prepared.latest
      : executeSqliteQueryTakeFirstSync(
          database.db,
          selectTranscriptAppendParentIdentity(database, sessionId),
        );
  const resolveFromNavigation = () =>
    scanSessionTranscriptTree(readTranscriptNavigationEvents(database, sessionId)).appendParentId;
  if (!retainedNavigation && !latest) {
    // Exact imports captured the append cursor while rebuilding their projection,
    // even though they did not transfer identity or idempotency ownership.
    const current = executeSqliteQueryTakeFirstSync(
      database.db,
      db
        .selectFrom("session_transcript_index_state as state")
        .innerJoin(
          "transcript_rewrite_watermarks as rewrite",
          "rewrite.session_id",
          "state.session_id",
        )
        .select("state.leaf_event_id")
        .where("state.session_id", "=", sessionId)
        .where("state.needs_rebuild", "=", 0)
        .where(
          "state.indexed_seq",
          "=",
          db
            .selectFrom("transcript_events")
            .select("seq")
            .where("session_id", "=", sessionId)
            .orderBy("seq", "desc")
            .limit(1),
        )
        .where((eb) =>
          eb.not(
            eb.exists(
              eb
                .selectFrom("session_transcript_active_events")
                .select("session_id")
                .where("session_id", "=", sessionId)
                .where("context_eligible", "is", null),
            ),
          ),
        ),
    );
    return current ? current.leaf_event_id : resolveFromNavigation();
  }
  try {
    const event =
      retainedNavigation ?? (latest ? (JSON.parse(latest.event_json) as unknown) : undefined);
    const treeEntry = parseSessionTranscriptTreeEntry(event);
    if (!treeEntry) {
      return resolveFromNavigation();
    }
    if ((retainedNavigation ? retainedIdentity?.event_type : latest?.event_type) !== "leaf") {
      return treeEntry.appendParentId;
    }
    if (actor) {
      // A retained leaf can target older history that a reset normalized away.
      return resolveFromNavigation();
    }
    const leafReferencesKnown =
      treeEntry.leafId !== undefined &&
      transcriptTreeReferenceExists(database, sessionId, treeEntry.leafId) &&
      transcriptTreeReferenceExists(database, sessionId, treeEntry.appendParentId);
    if (isSessionTranscriptLeafControl(event) && leafReferencesKnown) {
      return treeEntry.appendParentId;
    }
  } catch {
    // Fall through to the tolerant full-tree resolver.
  }
  return resolveFromNavigation();
}

function readTranscriptNavigationEvents(
  database: Pick<OpenClawAgentDatabase, "db" | "path">,
  sessionId: string,
): unknown[] {
  const actor = readSessionActorTransactionState(database, { sessionId });
  if (actor?.transcript.complete) {
    return structuredClone(actor.transcript.navigation);
  }
  const db = getSessionKysely(database.db);
  return Array.from(
    iterateSqliteQuerySync(
      database.db,
      db
        .selectFrom("transcript_events")
        .select(
          projectTranscriptNavigationSql(database.db, transcriptEventNavigationSql(database.db)).as(
            "event_json",
          ),
        )
        .where("session_id", "=", sessionId)
        .orderBy("seq", "asc"),
    ),
    (row) => JSON.parse(row.event_json) as unknown,
  );
}

function readTranscriptIdentityInTransaction(
  database: Pick<OpenClawAgentDatabase, "db" | "path">,
  sessionId: string,
  eventId: string,
): { eventId: string; parentId: string | null; seq: number } | undefined {
  const actor = readSessionActorTransactionState(database, { sessionId });
  if (actor) {
    const row = actor.transcript.identities.get(eventId);
    if (row || actor.transcript.complete) {
      return row ? { eventId: row.event_id, parentId: row.parent_id, seq: row.seq } : undefined;
    }
  }
  const db = getSessionKysely(database.db);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("transcript_event_identities")
      .select(["event_id", "parent_id", "seq"])
      .where("session_id", "=", sessionId)
      .where("event_id", "=", eventId)
      .limit(1),
  );
  return row ? { eventId: row.event_id, parentId: row.parent_id, seq: row.seq } : undefined;
}

function transcriptTreeReferenceExists(
  database: Pick<OpenClawAgentDatabase, "db" | "path">,
  sessionId: string,
  eventId: string | null,
): boolean {
  return (
    eventId === null ||
    readTranscriptIdentityInTransaction(database, sessionId, eventId) !== undefined
  );
}
