import type { AgentMessage, SessionTreeEntry } from "@openclaw/agent-core";
import { sql, type AliasableExpression, type RawBuilder, type SqlBool } from "kysely";
import { iterateSessionContextMessages } from "../../../packages/agent-core/src/harness/session/session.js";
import {
  isSyntheticMissingToolResult,
  SYNTHETIC_MISSING_TOOL_RESULT_DETAIL_KEY,
} from "../../../packages/agent-core/src/harness/session/tool-result-pairing.js";
import { jsonNativeFieldsValid } from "../../infra/database-engine/json-values.js";
import {
  executeSqliteQueryTakeFirstSync,
  iterateSqliteQuerySync,
  prepareSqliteQuerySync,
} from "../../infra/kysely-sync.js";
import { isPostgresSqlConnection } from "../../infra/sql-connection.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import type { UserTurnTranscriptAdmissionReceipt } from "../../sessions/user-turn-transcript.types.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { chunkItems } from "../../utils/chunk-items.js";
import type {
  SessionTranscriptContextVersion,
  SessionTranscriptReadScope,
  TranscriptEvent,
} from "./session-accessor.sqlite-contract.js";
import {
  getSessionKysely,
  resolveSqliteTranscriptReadScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import {
  assertSessionTranscriptContextAnchorInDatabase,
  type TranscriptSourceAuthority,
} from "./session-accessor.sqlite-transcript-anchor.js";
import { readTranscriptContextVersionInTransaction } from "./session-accessor.sqlite-transcript-state.js";
import { normalizeSessionContextEntryBoundaries } from "./session-entry-navigation.js";
import type {
  SessionModelContextLimits,
  SessionTranscriptModelContext,
} from "./session-history-read.types.js";
import { projectSessionModelContextEntry } from "./session-model-context-entry.js";
import { projectSessionModelContextNavigation } from "./session-model-context-navigation.js";
import { projectModelContextEventSql } from "./session-model-context-projection.js";
import { projectSessionModelContext } from "./session-model-context-read.js";
import type { ContextEntry, ModelContextRequest } from "./session-model-context-window.js";
import {
  resolveSqliteSessionTranscriptReadFence,
  runWithSessionTranscriptReadFence,
  SessionTranscriptReadFenceError,
} from "./session-transcript-read-fence.js";
import type { TranscriptEntryAnchor } from "./transcript-entry-anchor.js";
import {
  transcriptEventJsonSql,
  transcriptEventModelBytesSql,
  transcriptEventModelNavigationSql,
} from "./transcript-payload.js";
import { assertTranscriptNavigationValid } from "./transcript-predicate-fields.js";
import {
  scanSessionTranscriptTree,
  selectSessionTranscriptTreePathNodes,
} from "./transcript-tree.js";

export type { SessionModelContextLimits } from "./session-history-read.types.js";
type TranscriptContextSnapshot = {
  header: TranscriptEvent;
  entries: ContextEntry[];
  version: SessionTranscriptContextVersion;
  readEntry: (entry: ContextEntry) => SessionTreeEntry;
  readModelEntrySizes: (requests: readonly ModelContextRequest[]) => Map<ContextEntry, number>;
  readModelEntries: (
    requests: readonly ModelContextRequest[],
  ) => Map<ContextEntry, SessionTreeEntry>;
};

const MODEL_CONTEXT_PAYLOAD_BATCH_SIZE = 400;

/** Unadmitted context retains the prefix captured by its original read snapshot. */
export function validateSessionTranscriptContextVersion(
  scope: SessionTranscriptReadScope,
  version: SessionTranscriptContextVersion | undefined,
): void {
  validateDetachedSessionTranscriptContext(scope, { version });
}

function validateContextVersion(
  database: Pick<OpenClawAgentDatabase, "db">,
  sessionId: string,
  version: SessionTranscriptContextVersion | undefined,
  consistency: "exact" | "prefix",
): void {
  const current = readTranscriptContextVersionInTransaction(database, sessionId);
  if (
    current.generation === version?.generation &&
    current.rawSeq === version?.rawSeq &&
    current.updatedAt === version?.updatedAt
  ) {
    return;
  }
  const changed = () =>
    new SessionTranscriptReadFenceError("Session transcript changed during context read");
  if (
    consistency === "exact" ||
    !version?.generation ||
    current.generation !== version.generation ||
    version.rawSeq === null ||
    current.rawSeq === null ||
    current.rawSeq <= version.rawSeq
  ) {
    throw changed();
  }
  // Generation preserves prefix bytes; navigation must also preserve the original path.
  const entries = Array.from(
    iterateSqliteQuerySync(
      database.db,
      getSessionKysely(database.db)
        .selectFrom("transcript_events")
        .select([
          "seq",
          transcriptEventModelNavigationSql(database.db).as("navigation_json"),
          modelNavigationNativeSql(database.db).as("native"),
        ])
        .where("session_id", "=", sessionId)
        .orderBy("seq", "asc"),
    ),
    // SAFETY: The codec's navigation projection preserves entry discriminants and tree links.
    (row) => ({ ...readModelNavigation(row), seq: row.seq }),
  );
  const headSeq = version.rawSeq;
  const prefix = scanSessionTranscriptTree(entries.filter((entry) => entry.seq <= headSeq));
  const tree = scanSessionTranscriptTree(entries);
  const suffix = tree.nodes.filter(({ entry }) => entry.seq > headSeq);
  const expected = [...selectSessionTranscriptTreePathNodes(prefix, prefix.leafId), ...suffix];
  const path = selectSessionTranscriptTreePathNodes(tree, tree.leafId);
  if (
    entries.at(-1)?.seq !== current.rawSeq ||
    suffix.some(({ entry }) =>
      ["compaction", "reset", "leaf", "branch_summary"].includes(entry.type),
    ) ||
    expected.length !== path.length ||
    expected.some(
      (node, index) => node.id !== path[index]?.id || node.parentId !== path[index]?.parentId,
    )
  ) {
    throw changed();
  }
}

/** Revalidate admission after an asynchronous read before accepting its detached result. */
export function validateSessionTranscriptContextAdmission(
  scope: SessionTranscriptReadScope,
  admission: UserTurnTranscriptAdmissionReceipt | undefined,
): void {
  if (!admission) {
    return;
  }
  validateDetachedSessionTranscriptContext(scope, { admission });
}

type TranscriptContextValidation = {
  version?: SessionTranscriptContextVersion;
  admission?: UserTurnTranscriptAdmissionReceipt;
  through?: TranscriptEntryAnchor;
  expectedAuthority?: TranscriptSourceAuthority;
};

/** Released validators share admission; only multi-statement version reads need a snapshot. */
function validateDetachedSessionTranscriptContext(
  scope: SessionTranscriptReadScope,
  validation: Pick<TranscriptContextValidation, "version" | "admission">,
): void {
  const resolved = resolveSqliteTranscriptReadScope(scope);
  const result = withOpenClawAgentDatabaseReadOnly((database) => {
    const validate = () => {
      validateSessionTranscriptContextInDatabase(database, resolved, validation, "prefix");
    };
    return validation.admission
      ? validate()
      : runSqliteDeferredTransactionSync(database.db, validate);
  }, toDatabaseOptions(resolved));
  if (!result.found && (validation.admission || validation.version)) {
    throw new SessionTranscriptReadFenceError(
      validation.admission
        ? "Current-turn transcript admission is no longer readable"
        : "Session transcript changed during context read",
    );
  }
}

/** Validate detached context using the final reader's transaction-local facts. */
export function validateSessionTranscriptContextInDatabase(
  database: Pick<OpenClawAgentDatabase, "db" | "path">,
  resolved: ReturnType<typeof resolveSqliteTranscriptReadScope>,
  validation: TranscriptContextValidation,
  consistency: "exact" | "prefix" = "exact",
): void {
  const { version, admission, through } = validation;
  if (admission) {
    if (
      !runWithSessionTranscriptReadFence(admission, () =>
        resolveSqliteSessionTranscriptReadFence({ database, ...resolved }),
      )
    ) {
      throw new SessionTranscriptReadFenceError(
        "Current-turn transcript admission is no longer readable",
      );
    }
  } else if (!through) {
    validateContextVersion(database, resolved.sessionId, version, consistency);
  }
  if (through) {
    assertSessionTranscriptContextAnchorInDatabase(
      database,
      resolved,
      through,
      validation.expectedAuthority,
    );
  }
}

function modelContextBatchSql(requests: readonly ModelContextRequest[]) {
  const bySeq = new Map(requests.map(({ entry }) => [entry.seq, entry]));
  const omitted = requests.flatMap(({ entry, omitCheckpoint }) =>
    omitCheckpoint ? [entry.seq] : [],
  );
  const omitCheckpoint = omitted.length
    ? /* kysely-allow-raw: checkpoint omission is scoped to bound row identities in this payload batch. */ sql<number>`CASE WHEN seq IN (${sql.join(omitted)}) THEN 1 ELSE 0 END`
    : sql.lit(0);
  const omissions = requests.flatMap(({ entry, toolResultOmission }) =>
    toolResultOmission ? [sql`WHEN ${entry.seq} THEN ${toolResultOmission}`] : [],
  );
  const omission = omissions.length
    ? /* kysely-allow-raw: owned row identities and omission notices are bound values, not SQL text. */ sql<
        string | null
      >`CASE seq ${sql.join(omissions, sql` `)} ELSE NULL END`
    : undefined;
  return { bySeq, omitCheckpoint, omission };
}

/** Read a transient context without opening the writer lifecycle or copying native evidence. */
export function readSessionTranscriptModelContext(
  scope: SessionTranscriptReadScope,
  through?: TranscriptEntryAnchor,
  limits?: SessionModelContextLimits,
): SessionTranscriptModelContext {
  if (
    limits &&
    (!Number.isSafeInteger(limits.maxBytes) ||
      limits.maxBytes <= 0 ||
      !Number.isSafeInteger(limits.maxEvents) ||
      limits.maxEvents <= 0)
  ) {
    throw new RangeError("Model-context byte and event limits must be positive safe integers");
  }
  const result = withTranscriptContextSnapshot(
    scope,
    ({ header, entries, readModelEntries, readModelEntrySizes, version }) => {
      return projectSessionModelContext(
        { header, entries, readModelEntries, readModelEntrySizes, version },
        limits,
      );
    },
    through,
  );
  return result.found ? result.value : { events: [] };
}

/** Consume full-fidelity context lazily inside one read snapshot, never retaining raw history. */
export function readSessionTranscriptContextMessages<T>(
  scope: SessionTranscriptReadScope,
  read: (
    messages: Iterable<AgentMessage>,
    header: unknown,
    version?: SessionTranscriptContextVersion,
  ) => T,
): T {
  const result = withTranscriptContextSnapshot(scope, ({ header, entries, readEntry, version }) => {
    const messages = iterateSessionContextMessages(entries, readEntry);
    try {
      return read(messages, header, version);
    } finally {
      // Retained iterators cannot read after the snapshot closes, including early rejection.
      messages.return(undefined);
    }
  });
  return result.found ? result.value : read([], undefined);
}

function withTranscriptContextSnapshot<T>(
  scope: SessionTranscriptReadScope,
  read: (snapshot: TranscriptContextSnapshot) => T,
  through?: TranscriptEntryAnchor,
): { found: true; value: T } | { found: false } {
  const resolved = resolveSqliteTranscriptReadScope(scope);
  return withOpenClawAgentDatabaseReadOnly(
    (database) =>
      runSqliteDeferredTransactionSync(
        database.db,
        () => {
          const db = getSessionKysely(database.db);
          const native = modelNavigationNativeSql(database.db);
          const projectionValid = jsonNativeFieldsValid(
            database.db,
            sql`coalesce(event_json, '{}')`,
          );
          const exceptional = /* kysely-allow-raw: only PostgreSQL-undecodable rows cross into the JS model projector. */ sql<
            string | null
          >`CASE WHEN NOT ${native} THEN event_json END`;

          const fence = resolveSqliteSessionTranscriptReadFence({ database, ...resolved });
          const version = readTranscriptContextVersionInTransaction(database, resolved.sessionId);
          if (through) {
            assertSessionTranscriptContextAnchorInDatabase(database, resolved, through);
          }
          const base = db
            .selectFrom("transcript_events")
            .where("session_id", "=", resolved.sessionId)
            .$if(fence !== undefined, (query) => query.where("seq", "<", fence!.beforeRawSeq))
            .$if(through !== undefined, (query) => query.where("seq", "<=", through!.rawSeq));
          const header = executeSqliteQueryTakeFirstSync(
            database.db,
            base
              .select(transcriptEventJsonSql(database.db).as("event_json"))
              .select("navigation_valid")
              .where((eb) =>
                eb.or([eb("navigation_type", "=", "session"), eb("navigation_valid", "=", 0)]),
              )
              .orderBy("seq", "asc")
              .limit(1),
          );
          assertTranscriptNavigationValid(header?.navigation_valid);
          const tree = scanSessionTranscriptTree(
            (function* () {
              for (const row of iterateSqliteQuerySync(
                database.db,
                base
                  .select([
                    "seq",
                    modelNavigationNativeSql(database.db).as("native"),
                    transcriptEventModelNavigationSql(database.db).as("navigation_json"),
                  ])
                  .orderBy("seq", "asc"),
              )) {
                // Only navigation crosses into JavaScript before the canonical context is selected.
                // SAFETY: SQL preserves entry discriminants and replaces payloads with readable empty bodies.
                yield { ...readModelNavigation(row), seq: row.seq };
              }
            })(),
          );
          // Navigation entries belong to this snapshot; normalize ancestry without another copy.
          if (through && !tree.byId.has(through.entryId)) {
            throw new SessionTranscriptReadFenceError(
              "Completed-turn anchor is outside the admitted context",
            );
          }
          const entries = normalizeSessionContextEntryBoundaries(
            selectSessionTranscriptTreePathNodes(tree, through?.entryId ?? tree.leafId).map(
              ({ entry, parentId }) => {
                entry.parentId = parentId;
                return entry;
              },
            ),
            tree.nodes,
          );
          const readPayload = prepareSqliteQuerySync<ContextEntry, { event_json: string }>(
            database.db,
            (parameter) =>
              base.select(transcriptEventJsonSql(database.db).as("event_json")).where(
                "seq",
                "=",
                parameter((row) => row.seq),
              ),
          );
          return read({
            header: header ? JSON.parse(header.event_json) : undefined,
            entries,
            version,
            readEntry: (entry) => {
              const row = readPayload(entry).rows[0];
              return hydrateContextEntry(row!.event_json, entry);
            },
            readModelEntrySizes: (requests) => {
              const sizes = new Map<ContextEntry, number>();
              for (const batch of chunkItems(requests, MODEL_CONTEXT_PAYLOAD_BATCH_SIZE)) {
                const { bySeq, omitCheckpoint, omission } = modelContextBatchSql(batch);
                const query = base
                  .select((eb) => {
                    const storedBytes = transcriptEventModelBytesSql(database.db, omitCheckpoint);
                    // Stored costs describe the original model view, not a transient omission notice.
                    const bytes: AliasableExpression<number> = omission
                      ? eb
                          .case()
                          .when(omission, "is not", null)
                          .then(
                            eb.fn<number>("octet_length", [
                              projectModelContextEventSql(
                                database.db,
                                transcriptEventJsonSql(database.db),
                                omitCheckpoint,
                                omission,
                                eb.ref("message_role"),
                                projectionValid,
                              ),
                            ]),
                          )
                          .else(storedBytes)
                          .end()
                      : storedBytes;
                    return ["seq", bytes.as("bytes"), exceptional.as("exceptional_json")];
                  })
                  .where("seq", "in", [...bySeq.keys()]);
                for (const row of iterateSqliteQuerySync(database.db, query)) {
                  const entry = bySeq.get(row.seq)!;
                  const request = batch.find((item) => item.entry === entry)!;
                  sizes.set(
                    entry,
                    row.exceptional_json === null
                      ? row.bytes
                      : Buffer.byteLength(
                          JSON.stringify(
                            projectSessionModelContextEntry(
                              // SAFETY: The canonical payload matches its navigation entry in this read snapshot.
                              JSON.parse(row.exceptional_json) as SessionTreeEntry,
                              request,
                            ),
                          ),
                        ),
                  );
                }
              }
              return sizes;
            },
            readModelEntries: (requests) => {
              const payloads = new Map<ContextEntry, SessionTreeEntry>();
              for (const batch of chunkItems(requests, MODEL_CONTEXT_PAYLOAD_BATCH_SIZE)) {
                const { bySeq, omitCheckpoint, omission } = modelContextBatchSql(batch);
                // Bound both IN lists while keeping payload selection inside the navigation snapshot.
                // SQL removes obsolete replay/private fields before they enter JavaScript.
                const query = base
                  .select((eb) => [
                    "seq",
                    native.as("native"),
                    projectModelContextEventSql(
                      database.db,
                      transcriptEventJsonSql(database.db),
                      omitCheckpoint,
                      omission,
                      eb.ref("message_role"),
                      projectionValid,
                    ).as("event_json"),
                  ])
                  .where("seq", "in", [...bySeq.keys()]);
                for (const row of iterateSqliteQuerySync(database.db, query)) {
                  const entry = bySeq.get(row.seq)!;
                  const hydrated = row.native
                    ? hydrateContextEntry(row.event_json, entry)
                    : projectSessionModelContextEntry(
                        // SAFETY: The canonical payload matches its navigation entry in this read snapshot.
                        JSON.parse(row.event_json) as SessionTreeEntry,
                        batch.find((item) => item.entry === entry)!,
                      );
                  if (
                    entry.type === "message" &&
                    entry.message.role === "toolResult" &&
                    isSyntheticMissingToolResult(entry.message) &&
                    hydrated.type === "message" &&
                    hydrated.message.role === "toolResult"
                  ) {
                    // Retain pairing provenance after SQL removes opaque tool details.
                    hydrated.message.details = { [SYNTHETIC_MISSING_TOOL_RESULT_DETAIL_KEY]: true };
                  }
                  payloads.set(entry, hydrated);
                }
              }
              return payloads;
            },
          });
        },
        { operationLabel: "session context snapshot read" },
      ),
    toDatabaseOptions(resolved),
  );
}

function hydrateContextEntry(eventJson: string, entry: ContextEntry): SessionTreeEntry {
  return {
    // SAFETY: The canonical payload is selected by its navigation row in the same snapshot.
    ...(JSON.parse(eventJson) as SessionTreeEntry),
    parentId: entry.parentId,
    ...((entry.type === "compaction" || entry.type === "reset") &&
    entry.firstKeptEntryId !== undefined
      ? { firstKeptEntryId: entry.firstKeptEntryId }
      : {}),
  };
}

function modelNavigationNativeSql(
  database: Parameters<typeof isPostgresSqlConnection>[0],
): RawBuilder<SqlBool> {
  // SQLite projects deep rows inside its reader; PostgreSQL has no JS SQL callback.
  return isPostgresSqlConnection(database)
    ? jsonNativeFieldsValid(database, sql`event_json`)
    : sql.lit<SqlBool>(1);
}

function readModelNavigation(row: { navigation_json: string; native: unknown }): SessionTreeEntry {
  // SAFETY: The model navigation codec preserves canonical entry discriminants and empty payloads.
  const entry = JSON.parse(row.navigation_json) as SessionTreeEntry;
  return row.native ? entry : projectSessionModelContextNavigation(entry);
}
