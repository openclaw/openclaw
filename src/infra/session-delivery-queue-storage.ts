import { createHash } from "node:crypto";
import path from "node:path";
import type { ChatType } from "../channels/chat-type.js";
import { resolveStateDir } from "../config/paths.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import { generateSecureUuid } from "./secure-random.js";

const QUEUE_DIRNAME = "session-delivery-queue";
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

type DeliveryQueueEntryRow = {
  entry_json: string;
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

function parseQueueEntry(row: DeliveryQueueEntryRow | undefined): QueuedSessionDelivery | null {
  if (!row) {
    return null;
  }
  const parsed = JSON.parse(row.entry_json) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const entry = parsed as QueuedSessionDelivery;
  return typeof entry.id === "string" ? entry : null;
}

export function resolveSessionDeliveryQueueDir(stateDir?: string): string {
  const base = stateDir ?? resolveStateDir();
  return path.join(base, QUEUE_DIRNAME);
}

async function ensureSessionDeliveryQueueDir(stateDir?: string): Promise<string> {
  openOpenClawStateDatabase(databaseOptions(stateDir));
  return resolveSessionDeliveryQueueDir(stateDir);
}

export async function enqueueSessionDelivery(
  params: QueuedSessionDeliveryPayload,
  stateDir?: string,
): Promise<string> {
  await ensureSessionDeliveryQueueDir(stateDir);
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
  runOpenClawStateWriteTransaction((stateDatabase) => {
    const db = getNodeSqliteKysely<DeliveryQueueDatabase>(stateDatabase.db);
    executeSqliteQuerySync(
      stateDatabase.db,
      db
        .insertInto("delivery_queue_entries")
        .values({
          queue_name: QUEUE_NAME,
          id,
          status: "pending",
          entry_json: JSON.stringify(entry),
          enqueued_at: entry.enqueuedAt,
          updated_at: Date.now(),
          failed_at: null,
        })
        .onConflict((conflict) =>
          conflict.columns(["queue_name", "id"]).doUpdateSet({
            status: "pending",
            entry_json: JSON.stringify(entry),
            enqueued_at: entry.enqueuedAt,
            updated_at: Date.now(),
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
  const entry = await loadPendingSessionDelivery(id, stateDir);
  if (!entry) {
    const missing = new Error(
      `session delivery queue entry not found: ${id}`,
    ) as NodeJS.ErrnoException;
    missing.code = "ENOENT";
    throw missing;
  }
  entry.retryCount += 1;
  entry.lastAttemptAt = Date.now();
  entry.lastError = error;
  runOpenClawStateWriteTransaction((stateDatabase) => {
    const db = getNodeSqliteKysely<DeliveryQueueDatabase>(stateDatabase.db);
    executeSqliteQuerySync(
      stateDatabase.db,
      db
        .updateTable("delivery_queue_entries")
        .set({
          entry_json: JSON.stringify(entry),
          updated_at: Date.now(),
        })
        .where("queue_name", "=", QUEUE_NAME)
        .where("id", "=", id)
        .where("status", "=", "pending"),
    );
  }, databaseOptions(stateDir));
}

export async function loadPendingSessionDelivery(
  id: string,
  stateDir?: string,
): Promise<QueuedSessionDelivery | null> {
  const stateDatabase = openOpenClawStateDatabase(databaseOptions(stateDir));
  const db = getNodeSqliteKysely<DeliveryQueueDatabase>(stateDatabase.db);
  const row = executeSqliteQueryTakeFirstSync<DeliveryQueueEntryRow>(
    stateDatabase.db,
    db
      .selectFrom("delivery_queue_entries")
      .select(["entry_json"])
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
  const rows = executeSqliteQuerySync<DeliveryQueueEntryRow>(
    stateDatabase.db,
    db
      .selectFrom("delivery_queue_entries")
      .select(["entry_json"])
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
  const entry = await loadPendingSessionDelivery(id, stateDir);
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
          ...(entry ? { entry_json: JSON.stringify(entry) } : {}),
        })
        .where("queue_name", "=", QUEUE_NAME)
        .where("id", "=", id),
    );
  }, databaseOptions(stateDir));
}
