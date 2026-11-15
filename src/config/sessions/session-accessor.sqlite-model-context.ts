import type { AgentMessage, SessionTreeEntry } from "@openclaw/agent-core";
import { sql } from "kysely";
import { iterateSessionContextMessages } from "../../../packages/agent-core/src/harness/session/session.js";
import {
  isSyntheticMissingToolResult,
  SYNTHETIC_MISSING_TOOL_RESULT_DETAIL_KEY,
} from "../../../packages/agent-core/src/harness/session/tool-result-pairing.js";
import {
  jsonNativeFieldsValid,
  jsonLastStringValue,
} from "../../infra/database-engine/json-values.js";
import {
  executeSqliteQueryTakeFirstSync,
  iterateSqliteQuerySync,
  prepareSqliteQuerySync,
} from "../../infra/kysely-sync.js";
import { isPostgresSqlConnection } from "../../infra/sql-connection.js";
import { runSqliteReadSnapshotSync } from "../../infra/sqlite-transaction.js";
import type { UserTurnTranscriptAdmissionReceipt } from "../../sessions/user-turn-transcript.types.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { chunkItems } from "../../utils/chunk-items.js";
import type {
  SessionTranscriptContextVersion,
  SessionTranscriptReadScope,
  TranscriptEvent,
} from "./session-accessor.sqlite-contract.js";
import { resolveSqliteTranscriptReadScope } from "./session-accessor.sqlite-read-scope.js";
import { getSessionKysely, toDatabaseOptions } from "./session-accessor.sqlite-scope-helpers.js";
import {
  assertSessionTranscriptContextAnchorInDatabase,
  type TranscriptSourceAuthority,
} from "./session-accessor.sqlite-transcript-anchor.js";
import { readTranscriptContextVersionInTransaction } from "./session-accessor.sqlite-transcript-state.js";
import { readSessionContextSeed } from "./session-context-seed.js";
import type {
  SessionContextSeedRequest,
  SessionModelContextLimits,
  SessionTranscriptContextSnapshot,
  SessionTranscriptModelContext,
} from "./session-history-read.types.js";
import {
  hydrateSessionModelContextEntry,
  projectSessionModelContextEntry,
} from "./session-model-context-entry.js";
import { projectSessionModelContextNavigation } from "./session-model-context-navigation.js";
import { readModelContextNavigationPages } from "./session-model-context-pages.js";
import {
  projectModelContextEventSql,
  projectPostgresModelContextRowsSql,
} from "./session-model-context-projection.js";
import { projectSessionModelContext } from "./session-model-context-read.js";
import type {
  ContextEntry,
  ModelContextRequest,
  ModelContextPrefix,
} from "./session-model-context-window.js";
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
  transcriptEventNavigationSql,
  transcriptPredicateSql,
} from "./transcript-payload.js";
import { assertTranscriptNavigationValid } from "./transcript-predicate-fields.js";
import {
  scanSessionTranscriptTree,
  selectSessionTranscriptTreePathNodes,
} from "./transcript-tree.js";

export type { SessionModelContextLimits } from "./session-history-read.types.js";
export type TranscriptContextSnapshot = {
  prepared?: { requests: ModelContextRequest[]; prefix: ModelContextPrefix };
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
        .select(["seq", transcriptEventModelNavigationSql(database.db).as("navigation_json")])
        .where("session_id", "=", sessionId)
        .orderBy("seq", "asc"),
    ),
    (row) => {
      // SAFETY: The codec owns the navigation object; sequence comes from the same row.
      const entry = JSON.parse(row.navigation_json) as ContextEntry;
      entry.seq = row.seq;
      return entry;
    },
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
    return validation.admission ? validate() : runSqliteReadSnapshotSync(database.db, validate);
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
    ({ header, entries, readModelEntries, readModelEntrySizes, version, prepared }) => {
      return projectSessionModelContext(
        { header, entries, readModelEntries, readModelEntrySizes, version, prepared },
        limits,
      );
    },
    through,
    limits,
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

/** Select native history in its original snapshot before full payloads cross the worker. */
export function readSessionTranscriptContextSeed(
  scope: SessionTranscriptReadScope,
  seed: SessionContextSeedRequest,
): SessionTranscriptContextSnapshot {
  const result = withTranscriptContextSnapshot(
    scope,
    ({ header, entries, readEntry, version }) => ({
      ...readSessionContextSeed(entries, seed, readEntry),
      header,
      version,
    }),
    undefined,
    undefined,
    seed,
  );
  return result.found ? result.value : { ...readSessionContextSeed([], seed), header: undefined };
}

function withTranscriptContextSnapshot<T>(
  scope: SessionTranscriptReadScope,
  read: (snapshot: TranscriptContextSnapshot) => T,
  through?: TranscriptEntryAnchor,
  limits?: SessionModelContextLimits,
  seed?: SessionContextSeedRequest,
): { found: true; value: T } | { found: false } {
  const resolved = resolveSqliteTranscriptReadScope(scope);
  return withOpenClawAgentDatabaseReadOnly(
    (database) =>
      runSqliteReadSnapshotSync(
        database.db,
        () => {
          return read(prepareTranscriptContextSnapshot(database, resolved, through, limits, seed));
        },
        { operationLabel: "session context snapshot read" },
      ),
    toDatabaseOptions(resolved),
  );
}

export function prepareTranscriptEntryReader(
  database: Pick<OpenClawAgentDatabase, "db">,
  resolved: ReturnType<typeof resolveSqliteTranscriptReadScope>,
  version: SessionTranscriptContextVersion,
): (seq: number) => SessionTreeEntry {
  const current = readTranscriptContextVersionInTransaction(database, resolved.sessionId);
  const unchanged =
    current.generation === version.generation &&
    current.rawSeq === version.rawSeq &&
    current.updatedAt === version.updatedAt;
  if (
    !unchanged &&
    (!version.generation ||
      current.generation !== version.generation ||
      version.rawSeq === null ||
      current.rawSeq === null ||
      current.rawSeq < version.rawSeq)
  ) {
    throw new SessionTranscriptReadFenceError("Session transcript changed during context read");
  }
  const readPayload = prepareSqliteQuerySync<{ seq: number }, { event_json: string }>(
    database.db,
    (parameter) =>
      getSessionKysely(database.db)
        .selectFrom("transcript_events")
        .select(transcriptEventJsonSql(database.db).as("event_json"))
        .where("session_id", "=", resolved.sessionId)
        .where(
          "seq",
          "=",
          parameter((row) => row.seq),
        ),
  );
  return (seq) => {
    const row = readPayload({ seq }).rows[0];
    if (!row) {
      throw new SessionTranscriptReadFenceError("Session transcript changed during context read");
    }
    // SAFETY: The codec owns this fresh payload; navigation-only fields do not affect messages.
    return JSON.parse(row.event_json) as SessionTreeEntry;
  };
}

/** Prepare lazy payload readers inside the caller-owned read snapshot. */
export function prepareTranscriptContextSnapshot(
  database: Pick<OpenClawAgentDatabase, "db" | "path">,
  resolved: ReturnType<typeof resolveSqliteTranscriptReadScope>,
  through?: TranscriptEntryAnchor,
  limits?: SessionModelContextLimits,
  seed?: SessionContextSeedRequest,
): TranscriptContextSnapshot {
  const db = getSessionKysely(database.db);
  // Compressed rows were validated before encoding; inspect raw identity only.
  const nativeJsonValid = jsonNativeFieldsValid(database.db, sql`coalesce(event_json, '{}')`);
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
      .select(transcriptPredicateSql(database.db, "navigation_valid").as("navigation_valid"))
      .where((eb) =>
        eb.or([
          eb(transcriptPredicateSql(database.db, "navigation_type"), "=", "session"),
          eb(transcriptPredicateSql(database.db, "navigation_valid"), "=", 0),
        ]),
      )
      .orderBy("seq", "asc")
      .limit(1),
  );
  assertTranscriptNavigationValid(header?.navigation_valid);
  const {
    rows: navigation,
    entries,
    anchorFound,
    prepared,
  } = readModelContextNavigationPages({
    database: database.db,
    sessionId: resolved.sessionId,
    generation: version.generation,
    anchorId: through?.entryId,
    maxEvents: limits?.maxEvents,
    through: Math.min(
      version.rawSeq ?? -1,
      fence ? fence.beforeRawSeq - 1 : Infinity,
      through?.rawSeq ?? Infinity,
    ),
    *readRows(after, end) {
      const page = base.where("seq", ">", after).where("seq", "<=", end);
      const exceptional = isPostgresSqlConnection(database.db)
        ? Array.from(
            iterateSqliteQuerySync(
              database.db,
              page
                .select(["seq", "event_json"])
                .where("navigation_json", "is", null)
                .where((eb) => eb.not(jsonNativeFieldsValid(database.db, eb.ref("event_json")))),
            ),
          )
        : [];
      const query = isPostgresSqlConnection(database.db)
        ? db
            .selectFrom(
              projectPostgresModelContextRowsSql(
                page.select(["seq", "event_json", "navigation_json"]),
              ).as("context"),
            )
            .selectAll()
        : page
            .select([
              "seq",
              transcriptEventModelNavigationSql(database.db).as("navigation_json"),
              transcriptEventModelBytesSql(database.db, sql.lit(0)).as("model_bytes"),
              transcriptEventModelBytesSql(database.db, sql.lit(1)).as("retained_bytes"),
            ])
            .orderBy("seq", "asc");
      // JSONB rejects valid canonical escapes. Hydrate only those exceptional rows
      // inside the same bounded page and snapshot, using the shared model projector.
      const exceptionalBySeq = new Map(exceptional.map((row) => [row.seq, row.event_json]));
      for (const row of iterateSqliteQuerySync(database.db, query)) {
        const raw = exceptionalBySeq.get(row.seq);
        // SAFETY: Both native navigation and canonical rows belong to this snapshot.
        const original = raw ? (JSON.parse(raw) as SessionTreeEntry) : undefined;
        const entry = (
          original
            ? projectSessionModelContextNavigation(original)
            : JSON.parse(row.navigation_json)
        ) as ContextEntry;
        const model =
          original &&
          projectSessionModelContextEntry(original, { entry: original, omitCheckpoint: false });
        const retained =
          original &&
          projectSessionModelContextEntry(original, { entry: original, omitCheckpoint: true });
        entry.seq = row.seq;
        yield {
          entry,
          bytes: model ? Buffer.byteLength(JSON.stringify(model), "utf8") : row.model_bytes,
          withoutCheckpointBytes: retained
            ? Buffer.byteLength(JSON.stringify(retained), "utf8")
            : row.retained_bytes,
        };
      }
    },
  });
  if (!anchorFound) {
    throw new SessionTranscriptReadFenceError(
      "Completed-turn anchor is outside the admitted context",
    );
  }
  const readPayload = prepareSqliteQuerySync<ContextEntry, { event_json: string }>(
    database.db,
    (parameter) =>
      base.select(transcriptEventJsonSql(database.db).as("event_json")).where(
        "seq",
        "=",
        parameter((row) => row.seq),
      ),
  );
  if (seed) {
    // Full-fidelity seed policy needs two scalar facts absent from model navigation.
    // Read them inside this same snapshot. Only exceptional JSON needs a full payload
    // fallback, matching the model reader when native field decoding is unavailable.
    if (seed.admittedKey) {
      const source = transcriptEventNavigationSql(database.db);
      const native = jsonNativeFieldsValid(database.db, source);
      const key = jsonLastStringValue(database.db, source, ["message", "idempotencyKey"]);
      const role = jsonLastStringValue(database.db, source, ["message", "role"]);
      const bySeq = new Map(entries.map((entry) => [entry.seq, entry]));
      for (const row of iterateSqliteQuerySync(
        database.db,
        base
          .select(["seq", native.as("native")])
          // General role predicates and SQLite model navigation can select the first
          // outer message. Admission instead follows the full reader's final members.
          .where((eb) =>
            eb.or([
              eb.and([eb(key, "=", seed.admittedKey!), eb(role, "=", "user")]),
              eb.not(native),
            ]),
          ),
      )) {
        const entry = bySeq.get(row.seq);
        if (entry?.type === "message") {
          const full = row.native
            ? undefined
            : hydrateSessionModelContextEntry(readPayload(entry).rows[0]!.event_json, entry);
          if (
            row.native ||
            (full?.type === "message" &&
              full.message.role === "user" &&
              Reflect.get(full.message, "idempotencyKey") === seed.admittedKey)
          ) {
            Object.assign(entry.message, {
              role: "user",
              idempotencyKey: seed.admittedKey,
            });
          }
        }
      }
    }
    const source = transcriptEventJsonSql(database.db);
    const native = jsonNativeFieldsValid(database.db, source);
    const summary = jsonLastStringValue(database.db, source, ["summary"]);
    const summaries = new Set<number>();
    // Predicate discriminators intentionally omit branch_summary. Select the
    // canonical path's identities instead of losing those entries before hydration.
    for (const batch of chunkItems(
      entries.filter((entry) => entry.type === "branch_summary"),
      MODEL_CONTEXT_PAYLOAD_BATCH_SIZE,
    )) {
      for (const row of iterateSqliteQuerySync(
        database.db,
        base
          .select(["seq", native.as("native")])
          .where(
            "seq",
            "in",
            batch.map((entry) => entry.seq),
          )
          .where((eb) => eb.or([eb(summary, "!=", ""), eb.not(native)])),
      )) {
        const entry = batch.find((candidate) => candidate.seq === row.seq)!;
        const full = row.native
          ? undefined
          : hydrateSessionModelContextEntry(readPayload(entry).rows[0]!.event_json, entry);
        if (row.native || (full?.type === "branch_summary" && full.summary)) {
          summaries.add(row.seq);
        }
      }
    }
    for (const entry of entries) {
      if (entry.type === "branch_summary" && summaries.has(entry.seq)) {
        entry.summary = "nonempty";
      }
    }
  }
  return {
    prepared,
    header: header ? JSON.parse(header.event_json) : undefined,
    entries,
    version,
    readEntry: (entry) => {
      const row = readPayload(entry).rows[0];
      return hydrateSessionModelContextEntry(row!.event_json, entry);
    },
    readModelEntrySizes: (requests) => {
      const sizes = new Map<ContextEntry, number>();
      for (const request of requests) {
        if (!request.toolResultOmission) {
          const row = navigation.get(request.entry.seq)!;
          sizes.set(request.entry, request.omitCheckpoint ? row.withoutCheckpointBytes : row.bytes);
        }
      }
      for (const batch of chunkItems(
        requests.filter((request) => request.toolResultOmission),
        MODEL_CONTEXT_PAYLOAD_BATCH_SIZE,
      )) {
        const { bySeq, omitCheckpoint, omission } = modelContextBatchSql(batch);
        const query = base
          .select((eb) => [
            "seq",
            /* kysely-allow-raw: Only native-invalid canonical rows need bounded JavaScript projection. */
            sql<
              string | null
            >`CASE WHEN NOT ${nativeJsonValid} THEN ${transcriptEventJsonSql(database.db)} END`.as(
              "exceptional_json",
            ),
            eb
              .fn<number>("octet_length", [
                projectModelContextEventSql(
                  database.db,
                  transcriptEventJsonSql(database.db),
                  omitCheckpoint,
                  omission,
                  transcriptPredicateSql(database.db, "message_role"),
                  nativeJsonValid,
                ),
              ])
              .as("bytes"),
          ])
          .where("seq", "in", [...bySeq.keys()]);
        for (const row of iterateSqliteQuerySync(database.db, query)) {
          const request = batch.find(({ entry }) => entry.seq === row.seq)!;
          const projected =
            row.exceptional_json &&
            projectSessionModelContextEntry(
              hydrateSessionModelContextEntry(row.exceptional_json, request.entry),
              request,
            );
          sizes.set(
            request.entry,
            projected ? Buffer.byteLength(JSON.stringify(projected), "utf8") : row.bytes,
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
          .select([
            "seq",
            nativeJsonValid.as("native"),
            projectModelContextEventSql(
              database.db,
              transcriptEventJsonSql(database.db),
              omitCheckpoint,
              omission,
              transcriptPredicateSql(database.db, "message_role"),
              nativeJsonValid,
            ).as("event_json"),
          ])
          .where("seq", "in", [...bySeq.keys()]);
        for (const row of iterateSqliteQuerySync(database.db, query)) {
          const entry = bySeq.get(row.seq)!;
          let hydrated = hydrateSessionModelContextEntry(row.event_json, entry);
          if (!row.native) {
            hydrated = projectSessionModelContextEntry(
              hydrated,
              batch.find((request) => request.entry.seq === row.seq)!,
            );
          }
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
  };
}
