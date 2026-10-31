/** Lazy owner-native persistence for nonterminal outbound message progress. */
import { randomUUID } from "node:crypto";
import type { Insertable, Selectable } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { isPostgresSqlConnection, type EngineConnection } from "../infra/sql-connection.js";
import { normalizeSqliteNumber } from "../infra/sqlite-number.js";
import { stageSqliteTransactionState } from "../infra/sqlite-post-commit.js";
import { createSqliteSchemaEnsurer } from "../infra/sqlite-schema-ensure.js";
import { ensureStatePostgresFragment } from "../state/openclaw-state-db-engine.js";
import { ensureColumn, tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import { getOpenClawStateFeatureSchemaSql } from "../state/openclaw-state-feature-schema.js";
import type {
  OutboundMessageAuditEventRecord,
  OutboundMessageProgressInput,
} from "./audit-event-types.js";
import {
  clearAuditIdentityKeyCacheForDatabase,
  loadOrCreateAuditIdentityKey,
  pseudonymizeAuditIdentity,
} from "./audit-identity.js";
import {
  confirmMessageExecutionBinding,
  hasMessageExecutionBindingColumns,
  planMessageExecutionBinding,
  selectMessageExecutionBinding,
  type MessageExecutionBinding,
} from "./message-execution-binding.js";

type ProgressTable = OpenClawStateKyselyDatabase["outbound_message_progress"];
type ProgressDatabase = Pick<OpenClawStateKyselyDatabase, "outbound_message_progress">;
type ProgressRow = Selectable<ProgressTable>;

const OUTBOUND_MESSAGE_PROGRESS_RETENTION_MS = 30 * 24 * 60 * 60_000;
const OUTBOUND_MESSAGE_PROGRESS_MAX_ROWS = 200_000;
const OUTBOUND_MESSAGE_PROGRESS_PRUNE_BATCH_ROWS = 1_024;
const AUDIT_HMAC_REF_RE = /^hmac-sha256:v1:[a-f0-9]{32}:[a-f0-9]{64}$/u;
const ensuredDatabases = new WeakSet<EngineConnection>();
const progressRowCounts = new WeakMap<EngineConnection, number>();

function progressSchemaSql(): string {
  return getOpenClawStateFeatureSchemaSql("outbound_message_progress", {
    endMarker: "  ON outbound_message_progress (run_id, occurred_at, sequence);",
    errorMessage: "canonical outbound message progress schema is missing",
  });
}

function progressDb(db: EngineConnection) {
  return getNodeSqliteKysely<ProgressDatabase>(db);
}

const ensureProgressSchemaInDatabase = createSqliteSchemaEnsurer(progressSchemaSql, {
  tables: ["outbound_message_progress"],
  indexes: ["outbound_message_progress_occurred_idx", "outbound_message_progress_run_occurred_idx"],
});

function ensureProgressSchema(options: OpenClawStateDatabaseOptions): void {
  const database = openOpenClawStateDatabase(options);
  if (ensuredDatabases.has(database.db)) {
    return;
  }
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      if (isPostgresSqlConnection(db)) {
        ensureStatePostgresFragment(db, "outbound_message_progress");
      } else {
        ensureProgressSchemaInDatabase(db);
        ensureColumn(db, "outbound_message_progress", "context_id TEXT");
        ensureColumn(db, "outbound_message_progress", "execution_id TEXT");
      }
    },
    options,
    { operationLabel: "audit.outbound-message-progress.schema.ensure" },
  );
  ensuredDatabases.add(database.db);
  stageSqliteTransactionState(database.db, {
    commit: () => {},
    rollback: () => ensuredDatabases.delete(database.db),
    invalidate: () => ensuredDatabases.delete(database.db),
  });
}

function projectProgressIdentities(db: EngineConnection, input: OutboundMessageProgressInput) {
  const identity = loadOrCreateAuditIdentityKey(db);
  const conversationId = input.conversationId ?? input.targetId;
  const ref = (
    kind: Parameters<typeof pseudonymizeAuditIdentity>[0]["kind"],
    value: string | undefined,
  ) =>
    pseudonymizeAuditIdentity({
      identity,
      kind,
      channel: input.channel,
      ...(kind !== "account" && input.accountId !== undefined
        ? { accountId: input.accountId }
        : {}),
      value,
    });
  return {
    accountRef: ref("account", input.accountId),
    conversationRef: ref("conversation", conversationId),
    targetRef: ref("target", input.targetId),
  };
}

function bindProgressRow(
  db: EngineConnection,
  input: OutboundMessageProgressInput,
  executionBinding?: MessageExecutionBinding,
): Insertable<ProgressTable> {
  const refs = projectProgressIdentities(db, input);
  return {
    progress_id: randomUUID(),
    source_id: input.sourceId,
    source_sequence: input.sourceSequence,
    schema_version: 1,
    occurred_at: input.occurredAt,
    action: input.action,
    outcome: input.outcome,
    actor_type: input.actorType,
    actor_id: input.actorId,
    agent_id: input.agentId ?? null,
    run_id: input.runId ?? null,
    context_id: executionBinding?.contextId ?? null,
    execution_id: executionBinding?.executionId ?? null,
    channel: input.channel,
    conversation_kind: input.conversationKind,
    duration_ms: input.durationMs ?? null,
    account_ref: refs.accountRef ?? null,
    conversation_ref: refs.conversationRef ?? null,
    target_ref: refs.targetRef ?? null,
  };
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`corrupt outbound message progress row: invalid ${field}`);
  }
  return value;
}

function optionalText(value: unknown, field: string): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  return requiredText(value, field);
}

function optionalHmacRef(value: unknown, field: string): string | undefined {
  const ref = optionalText(value, field);
  if (ref !== undefined && !AUDIT_HMAC_REF_RE.test(ref)) {
    throw new Error(`corrupt outbound message progress row: invalid ${field}`);
  }
  return ref;
}

function rowToProgressEvent(row: ProgressRow): OutboundMessageAuditEventRecord {
  const sequence = normalizeSqliteNumber(row.sequence);
  const sourceSequence = normalizeSqliteNumber(row.source_sequence);
  const occurredAt = normalizeSqliteNumber(row.occurred_at);
  const durationMs = normalizeSqliteNumber(row.duration_ms);
  if (
    sequence === undefined ||
    sequence < 1 ||
    sourceSequence === undefined ||
    sourceSequence < 1 ||
    occurredAt === undefined ||
    occurredAt < 0 ||
    row.schema_version !== 1 ||
    (durationMs !== undefined && durationMs < 0)
  ) {
    throw new Error("corrupt outbound message progress row: invalid numeric field");
  }
  if (
    (row.action === "message.outbound.queued" && row.outcome !== "queued") ||
    (row.action === "message.outbound.platform-started" && row.outcome !== "platform_started") ||
    (row.action !== "message.outbound.queued" && row.action !== "message.outbound.platform-started")
  ) {
    throw new Error("corrupt outbound message progress row: invalid lifecycle field");
  }
  const actorType =
    row.actor_type === "agent" ? "agent" : row.actor_type === "system" ? "system" : undefined;
  if (!actorType) {
    throw new Error("corrupt outbound message progress row: invalid actor type");
  }
  const conversationKind =
    row.conversation_kind === "direct"
      ? "direct"
      : row.conversation_kind === "group"
        ? "group"
        : row.conversation_kind === "channel"
          ? "channel"
          : row.conversation_kind === "unknown"
            ? "unknown"
            : undefined;
  if (!conversationKind) {
    throw new Error("corrupt outbound message progress row: invalid conversation kind");
  }
  const common = {
    schemaVersion: 1 as const,
    sequence,
    eventId: requiredText(row.progress_id, "progressId"),
    sourceSequence,
    occurredAt,
    redaction: "metadata_only" as const,
    kind: "message" as const,
    actorType,
    actorId: requiredText(row.actor_id, "actorId"),
    ...(optionalText(row.agent_id, "agentId") !== undefined ? { agentId: row.agent_id! } : {}),
    ...(optionalText(row.run_id, "runId") !== undefined ? { runId: row.run_id! } : {}),
    direction: "outbound" as const,
    channel: requiredText(row.channel, "channel"),
    conversationKind,
    ...(durationMs !== undefined ? { durationMs } : {}),
    resultCount: 0,
    ...(optionalHmacRef(row.account_ref, "accountRef") !== undefined
      ? { accountRef: row.account_ref! }
      : {}),
    ...(optionalHmacRef(row.conversation_ref, "conversationRef") !== undefined
      ? { conversationRef: row.conversation_ref! }
      : {}),
    ...(optionalHmacRef(row.target_ref, "targetRef") !== undefined
      ? { targetRef: row.target_ref! }
      : {}),
  } as const;
  return row.action === "message.outbound.queued"
    ? { ...common, action: row.action, status: "started", outcome: "queued" }
    : { ...common, action: row.action, status: "started", outcome: "platform_started" };
}

function countProgressRows(db: EngineConnection): number {
  const row = executeSqliteQueryTakeFirstSync(
    db,
    progressDb(db)
      .selectFrom("outbound_message_progress")
      .select((expression) => expression.fn.countAll<number>().as("count")),
  );
  return normalizeSqliteNumber(row?.count ?? null) ?? 0;
}

function deleteExpiredProgressRows(db: EngineConnection, now: number, limit: number) {
  const kysely = progressDb(db);
  const expiredSequences = kysely
    .selectFrom("outbound_message_progress")
    .select("sequence")
    .where("occurred_at", "<", now - OUTBOUND_MESSAGE_PROGRESS_RETENTION_MS)
    .orderBy("occurred_at", "asc")
    .orderBy("sequence", "asc")
    .limit(limit);
  return executeSqliteQuerySync(
    db,
    kysely.deleteFrom("outbound_message_progress").where("sequence", "in", expiredSequences),
  );
}

function pruneProgressAfterInsert(db: EngineConnection, now: number): void {
  stageSqliteTransactionState(db, {
    commit: () => {},
    rollback: () => progressRowCounts.delete(db),
    invalidate: () => progressRowCounts.delete(db),
  });
  const kysely = progressDb(db);
  const expired = deleteExpiredProgressRows(db, now, OUTBOUND_MESSAGE_PROGRESS_PRUNE_BATCH_ROWS);
  const cachedCount = progressRowCounts.get(db);
  let rowCount =
    cachedCount === undefined
      ? countProgressRows(db)
      : Math.max(0, cachedCount + 1 - Number(expired.numAffectedRows ?? 0n));
  if (rowCount <= OUTBOUND_MESSAGE_PROGRESS_MAX_ROWS) {
    progressRowCounts.set(db, rowCount);
    return;
  }
  const retainedRows = Math.max(
    0,
    OUTBOUND_MESSAGE_PROGRESS_MAX_ROWS - OUTBOUND_MESSAGE_PROGRESS_PRUNE_BATCH_ROWS,
  );
  const overflowCutoff = kysely
    .selectFrom("outbound_message_progress")
    .select("sequence")
    .orderBy("sequence", "desc")
    .offset(retainedRows)
    .limit(1);
  const pruned = executeSqliteQuerySync(
    db,
    kysely.deleteFrom("outbound_message_progress").where("sequence", "<=", overflowCutoff),
  );
  rowCount = Math.max(0, rowCount - Number(pruned.numAffectedRows ?? 0n));
  progressRowCounts.set(db, rowCount);
}

/** Persist one progress fact idempotently; first use installs only this owner table. */
export function recordOutboundMessageProgressInDatabase(
  input: OutboundMessageProgressInput,
  options: OpenClawStateDatabaseOptions & { database: OpenClawStateDatabase },
): OutboundMessageAuditEventRecord | undefined {
  const executionToken = planMessageExecutionBinding(input.executionIdentityToken, input.runId);
  ensureProgressSchema(options);
  let cacheDatabase: EngineConnection | undefined;
  try {
    return runOpenClawStateWriteTransaction(({ db }) => {
      cacheDatabase = db;
      const executionBinding = confirmMessageExecutionBinding(db, executionToken);
      const insert = executeSqliteQueryTakeFirstSync(
        db,
        progressDb(db)
          .insertInto("outbound_message_progress")
          .values(bindProgressRow(db, input, executionBinding))
          .onConflict((conflict) => conflict.column("source_id").doNothing())
          .returning("sequence"),
      );
      if (!insert) {
        return undefined;
      }
      const sequence = insert.sequence;
      if (!Number.isSafeInteger(sequence) || sequence < 1) {
        throw new Error("outbound message progress sequence is outside the supported range");
      }
      pruneProgressAfterInsert(db, Date.now());
      const row = executeSqliteQueryTakeFirstSync(
        db,
        progressDb(db)
          .selectFrom("outbound_message_progress")
          .selectAll()
          .where("sequence", "=", sequence),
      );
      return row ? rowToProgressEvent(row) : undefined;
    }, options);
  } catch (error) {
    if (cacheDatabase) {
      progressRowCounts.delete(cacheDatabase);
      clearAuditIdentityKeyCacheForDatabase(cacheDatabase);
    }
    throw error;
  }
}

export function countOutboundMessageProgressForRunInDatabase(
  db: EngineConnection,
  params: {
    runId: string;
    contextId?: string;
    executionId?: string;
    now?: number;
  },
): number {
  const exact = selectMessageExecutionBinding(params);
  if (
    !tableExists(db, "outbound_message_progress") ||
    (exact && !hasMessageExecutionBindingColumns(db, "outbound_message_progress"))
  ) {
    return 0;
  }
  let query = progressDb(db)
    .selectFrom("outbound_message_progress")
    .select((expression) => expression.fn.countAll<number>().as("count"))
    .where("run_id", "=", params.runId)
    .where(
      "occurred_at",
      ">=",
      (params.now ?? Date.now()) - OUTBOUND_MESSAGE_PROGRESS_RETENTION_MS,
    );
  if (exact) {
    query = query
      .where("context_id", "=", exact.contextId)
      .where("execution_id", "=", exact.executionId);
  }
  const row = executeSqliteQueryTakeFirstSync(db, query);
  return normalizeSqliteNumber(row?.count ?? null) ?? 0;
}

export function readOutboundMessageProgressForRunInDatabase(
  db: EngineConnection,
  params: {
    runId: string;
    contextId?: string;
    executionId?: string;
    action: OutboundMessageProgressInput["action"];
    after?: { occurredAt: number; sequence: number };
    limit: number;
    now?: number;
  },
): OutboundMessageAuditEventRecord[] {
  const exact = selectMessageExecutionBinding(params);
  if (
    !tableExists(db, "outbound_message_progress") ||
    (exact && !hasMessageExecutionBindingColumns(db, "outbound_message_progress"))
  ) {
    return [];
  }
  let query = progressDb(db)
    .selectFrom("outbound_message_progress")
    .selectAll()
    .where("run_id", "=", params.runId)
    .where("action", "=", params.action)
    .where(
      "occurred_at",
      ">=",
      (params.now ?? Date.now()) - OUTBOUND_MESSAGE_PROGRESS_RETENTION_MS,
    );
  if (exact) {
    query = query
      .where("context_id", "=", exact.contextId)
      .where("execution_id", "=", exact.executionId);
  }
  const after = params.after;
  if (after) {
    query = query.where((expression) =>
      expression.or([
        expression("occurred_at", ">", after.occurredAt),
        expression.and([
          expression("occurred_at", "=", after.occurredAt),
          expression("sequence", ">", after.sequence),
        ]),
      ]),
    );
  }
  return executeSqliteQuerySync(
    db,
    query.orderBy("occurred_at", "asc").orderBy("sequence", "asc").limit(params.limit),
  ).rows.map(rowToProgressEvent);
}

export function hasOutboundMessageProgressCursorInDatabase(
  db: EngineConnection,
  params: {
    runId: string;
    contextId?: string;
    executionId?: string;
    occurredAt: number;
    sequence: number;
    action: OutboundMessageProgressInput["action"];
  },
): boolean {
  const exact = selectMessageExecutionBinding(params);
  if (
    !tableExists(db, "outbound_message_progress") ||
    (exact && !hasMessageExecutionBindingColumns(db, "outbound_message_progress"))
  ) {
    return false;
  }
  let query = progressDb(db)
    .selectFrom("outbound_message_progress")
    .select("sequence")
    .where("sequence", "=", params.sequence)
    .where("run_id", "=", params.runId)
    .where("occurred_at", "=", params.occurredAt)
    .where("action", "=", params.action);
  if (exact) {
    query = query
      .where("context_id", "=", exact.contextId)
      .where("execution_id", "=", exact.executionId);
  }
  return Boolean(executeSqliteQueryTakeFirstSync(db, query));
}

/** Prune existing progress without creating its lazy table. */
export function pruneExpiredOutboundMessageProgressInDatabase(params: {
  now?: number;
  database: OpenClawStateDatabaseOptions & { database: OpenClawStateDatabase };
}): number {
  const database = openOpenClawStateDatabase(params.database);
  if (!tableExists(database.db, "outbound_message_progress")) {
    return 0;
  }
  return runOpenClawStateWriteTransaction(({ db }) => {
    const deleted = deleteExpiredProgressRows(
      db,
      params.now ?? Date.now(),
      OUTBOUND_MESSAGE_PROGRESS_PRUNE_BATCH_ROWS,
    );
    progressRowCounts.delete(db);
    return Number(deleted.numAffectedRows ?? 0n);
  }, params.database);
}
