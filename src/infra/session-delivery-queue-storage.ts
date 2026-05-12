import { createHash } from "node:crypto";
import type { Insertable, Selectable } from "kysely";
import type { ChatType } from "../channels/chat-type.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import {
  isDeliveryQueueEntryWithId,
  parseDeliveryQueueEntryJson,
} from "./delivery-queue-entry-json.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import { generateSecureUuid } from "./secure-random.js";
import { sqliteNullableNumber, sqliteNullableText } from "./sqlite-row-values.js";

const QUEUE_NAME = "session-delivery";

type SessionDeliveryContext = {
  channel?: string;
  to?: string;
  accountId?: string;
  threadId?: string | number;
};

type SessionDeliveryRetryPolicy = {
  maxRetries?: number;
};

export type SessionDeliveryRoute = {
  channel: string;
  to: string;
  accountId?: string;
  replyToId?: string;
  threadId?: string;
  chatType: ChatType;
};

export type QueuedSessionDeliveryPayload =
  | ({
      kind: "systemEvent";
      sessionKey: string;
      text: string;
      deliveryContext?: SessionDeliveryContext;
      idempotencyKey?: string;
    } & SessionDeliveryRetryPolicy)
  | ({
      kind: "agentTurn";
      sessionKey: string;
      message: string;
      messageId: string;
      route?: SessionDeliveryRoute;
      deliveryContext?: SessionDeliveryContext;
      idempotencyKey?: string;
    } & SessionDeliveryRetryPolicy);

export type QueuedSessionDelivery = QueuedSessionDeliveryPayload & {
  id: string;
  enqueuedAt: number;
  retryCount: number;
  lastAttemptAt?: number;
  lastError?: string;
};

type DeliveryQueueDatabase = Pick<OpenClawStateKyselyDatabase, "delivery_queue_entries">;
type DeliveryQueueEntriesTable = OpenClawStateKyselyDatabase["delivery_queue_entries"];
type DeliveryQueueEntryRow = Insertable<DeliveryQueueEntriesTable>;
type DeliveryQueueEntryStoredRow = Selectable<DeliveryQueueEntriesTable>;
type DeliveryQueueEntryFields = {
  account_id: string | null;
  channel: string | null;
  entry_json: string;
  last_attempt_at: number | null;
  last_error: string | null;
  retry_count: number;
  session_key: string;
  target: string | null;
  updated_at: number;
};

function buildEntryId(idempotencyKey?: string): string {
  if (!idempotencyKey) {
    return generateSecureUuid();
  }
  return createHash("sha256").update(idempotencyKey).digest("hex");
}

function databaseOptions(stateDir?: string): OpenClawStateDatabaseOptions {
  return stateDir ? { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } } : {};
}

function isQueuedSessionDelivery(value: unknown): value is QueuedSessionDelivery {
  if (
    !isDeliveryQueueEntryWithId(value) ||
    typeof value.sessionKey !== "string" ||
    typeof value.enqueuedAt !== "number" ||
    !Number.isFinite(value.enqueuedAt) ||
    typeof value.retryCount !== "number" ||
    !Number.isFinite(value.retryCount)
  ) {
    return false;
  }
  if (value.kind === "systemEvent") {
    return typeof value.text === "string";
  }
  return value.kind === "agentTurn"
    ? typeof value.message === "string" && typeof value.messageId === "string"
    : false;
}

function mergeStoredRoute(
  entry: QueuedSessionDelivery,
  row: DeliveryQueueEntryStoredRow,
): QueuedSessionDelivery {
  const accountId = sqliteNullableText(row.account_id);
  const channel = sqliteNullableText(row.channel);
  const target = sqliteNullableText(row.target);
  if (!accountId && !channel && !target) {
    return entry;
  }
  if (entry.kind === "agentTurn" && entry.route) {
    return {
      ...entry,
      route: {
        ...entry.route,
        ...(accountId ? { accountId } : {}),
        ...(channel ? { channel } : {}),
        ...(target ? { to: target } : {}),
      },
    };
  }
  return {
    ...entry,
    deliveryContext: {
      ...entry.deliveryContext,
      ...(accountId ? { accountId } : {}),
      ...(channel ? { channel } : {}),
      ...(target ? { to: target } : {}),
    },
  };
}

function parseQueueEntry(
  row: DeliveryQueueEntryStoredRow | undefined,
): QueuedSessionDelivery | null {
  const entry = parseDeliveryQueueEntryJson(row, isQueuedSessionDelivery);
  if (!entry || !row) {
    return entry;
  }
  return mergeStoredRoute(
    {
      ...entry,
      id: row.id,
      enqueuedAt: row.enqueued_at,
      lastAttemptAt: sqliteNullableNumber(row.last_attempt_at) ?? undefined,
      lastError: sqliteNullableText(row.last_error) ?? undefined,
      retryCount: row.retry_count,
      sessionKey: sqliteNullableText(row.session_key) ?? entry.sessionKey,
    },
    row,
  );
}

function resolveSessionDeliveryRoute(entry: QueuedSessionDelivery): {
  accountId: string | null;
  channel: string | null;
  target: string | null;
} {
  return {
    accountId:
      sqliteNullableText(entry.kind === "agentTurn" ? entry.route?.accountId : undefined) ??
      sqliteNullableText(entry.deliveryContext?.accountId),
    channel:
      sqliteNullableText(entry.kind === "agentTurn" ? entry.route?.channel : undefined) ??
      sqliteNullableText(entry.deliveryContext?.channel),
    target:
      sqliteNullableText(entry.kind === "agentTurn" ? entry.route?.to : undefined) ??
      sqliteNullableText(entry.deliveryContext?.to),
  };
}

function sessionDeliveryQueueEntryFields(
  entry: QueuedSessionDelivery,
  updatedAt: number,
): DeliveryQueueEntryFields {
  const route = resolveSessionDeliveryRoute(entry);
  return {
    account_id: route.accountId,
    channel: route.channel,
    entry_json: JSON.stringify(entry),
    last_attempt_at: sqliteNullableNumber(entry.lastAttemptAt),
    last_error: sqliteNullableText(entry.lastError),
    retry_count: sqliteNullableNumber(entry.retryCount) ?? 0,
    session_key: entry.sessionKey,
    target: route.target,
    updated_at: updatedAt,
  };
}

function sessionDeliveryQueueEntryToRow(
  entry: QueuedSessionDelivery,
  updatedAt: number,
): DeliveryQueueEntryRow {
  return {
    queue_name: QUEUE_NAME,
    id: entry.id,
    status: "pending",
    entry_kind: entry.kind,
    recovery_state: null,
    platform_send_started_at: null,
    enqueued_at: entry.enqueuedAt,
    failed_at: null,
    ...sessionDeliveryQueueEntryFields(entry, updatedAt),
  };
}

function ensureSessionDeliveryQueueStorage(stateDir?: string): void {
  openOpenClawStateDatabase(databaseOptions(stateDir));
}

export async function enqueueSessionDelivery(
  params: QueuedSessionDeliveryPayload,
  stateDir?: string,
): Promise<string> {
  ensureSessionDeliveryQueueStorage(stateDir);
  const id = buildEntryId(params.idempotencyKey);

  if (params.idempotencyKey) {
    if (await loadPendingSessionDelivery(id, stateDir)) {
      return id;
    }
  }

  const entry: QueuedSessionDelivery = {
    ...params,
    id,
    enqueuedAt: Date.now(),
    retryCount: 0,
  };
  const now = Date.now();
  runOpenClawStateWriteTransaction((stateDatabase) => {
    const db = getNodeSqliteKysely<DeliveryQueueDatabase>(stateDatabase.db);
    executeSqliteQuerySync(
      stateDatabase.db,
      db
        .insertInto("delivery_queue_entries")
        .values(sessionDeliveryQueueEntryToRow(entry, now))
        .onConflict((conflict) =>
          conflict.columns(["queue_name", "id"]).doUpdateSet({
            status: "pending",
            ...sessionDeliveryQueueEntryFields(entry, now),
            enqueued_at: entry.enqueuedAt,
            failed_at: null,
          }),
        ),
    );
  }, databaseOptions(stateDir));
  return id;
}

export async function ackSessionDelivery(id: string, stateDir?: string): Promise<void> {
  runOpenClawStateWriteTransaction((stateDatabase) => {
    const db = getNodeSqliteKysely<DeliveryQueueDatabase>(stateDatabase.db);
    executeSqliteQuerySync(
      stateDatabase.db,
      db
        .deleteFrom("delivery_queue_entries")
        .where("queue_name", "=", QUEUE_NAME)
        .where("id", "=", id),
    );
  }, databaseOptions(stateDir));
}

export async function failSessionDelivery(
  id: string,
  error: string,
  stateDir?: string,
): Promise<void> {
  const now = Date.now();
  let changed = 0n;
  runOpenClawStateWriteTransaction((stateDatabase) => {
    const db = getNodeSqliteKysely<DeliveryQueueDatabase>(stateDatabase.db);
    const result = executeSqliteQuerySync(
      stateDatabase.db,
      db
        .updateTable("delivery_queue_entries")
        .set((eb) => ({
          last_attempt_at: now,
          last_error: sqliteNullableText(error),
          retry_count: eb("retry_count", "+", 1),
          updated_at: now,
        }))
        .where("queue_name", "=", QUEUE_NAME)
        .where("id", "=", id)
        .where("status", "=", "pending"),
    );
    changed = result.numAffectedRows ?? 0n;
  }, databaseOptions(stateDir));
  if (changed === 0n) {
    const missing = new Error(
      `session delivery queue entry not found: ${id}`,
    ) as NodeJS.ErrnoException;
    missing.code = "ENOENT";
    throw missing;
  }
}

export async function loadPendingSessionDelivery(
  id: string,
  stateDir?: string,
): Promise<QueuedSessionDelivery | null> {
  const stateDatabase = openOpenClawStateDatabase(databaseOptions(stateDir));
  const db = getNodeSqliteKysely<DeliveryQueueDatabase>(stateDatabase.db);
  const row = executeSqliteQueryTakeFirstSync(
    stateDatabase.db,
    db
      .selectFrom("delivery_queue_entries")
      .selectAll()
      .where("queue_name", "=", QUEUE_NAME)
      .where("id", "=", id)
      .where("status", "=", "pending"),
  );
  return parseQueueEntry(row);
}

export async function loadPendingSessionDeliveries(
  stateDir?: string,
): Promise<QueuedSessionDelivery[]> {
  const stateDatabase = openOpenClawStateDatabase(databaseOptions(stateDir));
  const db = getNodeSqliteKysely<DeliveryQueueDatabase>(stateDatabase.db);
  const rows = executeSqliteQuerySync(
    stateDatabase.db,
    db
      .selectFrom("delivery_queue_entries")
      .selectAll()
      .where("queue_name", "=", QUEUE_NAME)
      .where("status", "=", "pending")
      .orderBy("enqueued_at", "asc")
      .orderBy("id", "asc"),
  ).rows;
  return rows
    .map(parseQueueEntry)
    .filter((entry): entry is QueuedSessionDelivery => entry !== null);
}

export async function moveSessionDeliveryToFailed(id: string, stateDir?: string): Promise<void> {
  const now = Date.now();
  runOpenClawStateWriteTransaction((stateDatabase) => {
    const db = getNodeSqliteKysely<DeliveryQueueDatabase>(stateDatabase.db);
    executeSqliteQuerySync(
      stateDatabase.db,
      db
        .updateTable("delivery_queue_entries")
        .set({
          status: "failed",
          updated_at: now,
          failed_at: now,
        })
        .where("queue_name", "=", QUEUE_NAME)
        .where("id", "=", id),
    );
  }, databaseOptions(stateDir));
}
