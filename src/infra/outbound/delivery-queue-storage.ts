import type { ReplyPayload } from "../../auto-reply/types.js";
import type { RenderedMessageBatchPlanItem } from "../../channels/message/types.js";
import type { ReplyToMode } from "../../config/types.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../../state/openclaw-state-db.js";
import {
  isDeliveryQueueEntryWithId,
  parseDeliveryQueueEntryJson,
  type DeliveryQueueEntryJsonRow,
} from "../delivery-queue-entry-json.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../kysely-sync.js";
import { generateSecureUuid } from "../secure-random.js";
import type { OutboundDeliveryFormattingOptions } from "./formatting.js";
import type { OutboundIdentity } from "./identity.js";
import type { OutboundMirror } from "./mirror.js";
import type { OutboundSessionContext } from "./session-context.js";
import type { OutboundChannel } from "./targets.js";

const QUEUE_NAME = "outbound-delivery";

export type QueuedRenderedMessageBatchPlan = {
  payloadCount: number;
  textCount: number;
  mediaCount: number;
  voiceCount: number;
  presentationCount: number;
  interactiveCount: number;
  channelDataCount: number;
  items: readonly RenderedMessageBatchPlanItem[];
};

export type QueuedDeliveryPayload = {
  channel: Exclude<OutboundChannel, "none">;
  to: string;
  accountId?: string;
  /**
   * Original payloads before plugin hooks. On recovery, hooks re-run on these
   * payloads — this is intentional since hooks are stateless transforms and
   * should produce the same result on replay.
   */
  payloads: ReplyPayload[];
  /** Replayable projection summary captured when the durable send intent is created. */
  renderedBatchPlan?: QueuedRenderedMessageBatchPlan;
  threadId?: string | number | null;
  replyToId?: string | null;
  replyToMode?: ReplyToMode;
  formatting?: OutboundDeliveryFormattingOptions;
  identity?: OutboundIdentity;
  bestEffort?: boolean;
  gifPlayback?: boolean;
  forceDocument?: boolean;
  silent?: boolean;
  mirror?: OutboundMirror;
  /** Session context needed to preserve outbound media policy on recovery. */
  session?: OutboundSessionContext;
  /** Gateway caller scopes at enqueue time, preserved for recovery replay. */
  gatewayClientScopes?: readonly string[];
};

export interface QueuedDelivery extends QueuedDeliveryPayload {
  id: string;
  enqueuedAt: number;
  retryCount: number;
  lastAttemptAt?: number;
  lastError?: string;
  platformSendStartedAt?: number;
  recoveryState?: "send_attempt_started" | "unknown_after_send";
}

type DeliveryQueueDatabase = Pick<OpenClawStateKyselyDatabase, "delivery_queue_entries">;

function databaseOptions(stateDir?: string): OpenClawStateDatabaseOptions {
  return stateDir ? { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } } : {};
}

function normalizeLegacyQueuedDeliveryEntry(entry: QueuedDelivery): {
  entry: QueuedDelivery;
  migrated: boolean;
} {
  const hasAttemptTimestamp =
    typeof entry.lastAttemptAt === "number" &&
    Number.isFinite(entry.lastAttemptAt) &&
    entry.lastAttemptAt > 0;
  if (hasAttemptTimestamp || entry.retryCount <= 0) {
    return { entry, migrated: false };
  }
  const hasEnqueuedTimestamp =
    typeof entry.enqueuedAt === "number" &&
    Number.isFinite(entry.enqueuedAt) &&
    entry.enqueuedAt > 0;
  if (!hasEnqueuedTimestamp) {
    return { entry, migrated: false };
  }
  return {
    entry: {
      ...entry,
      lastAttemptAt: entry.enqueuedAt,
    },
    migrated: true,
  };
}

function createMissingQueueEntryError(id: string): NodeJS.ErrnoException {
  const error = new Error(`delivery queue entry not found: ${id}`) as NodeJS.ErrnoException;
  error.code = "ENOENT";
  return error;
}

function isQueuedDelivery(value: unknown): value is QueuedDelivery {
  return (
    isDeliveryQueueEntryWithId(value) &&
    typeof value.channel === "string" &&
    typeof value.to === "string" &&
    Array.isArray(value.payloads) &&
    typeof value.enqueuedAt === "number" &&
    Number.isFinite(value.enqueuedAt) &&
    typeof value.retryCount === "number" &&
    Number.isFinite(value.retryCount)
  );
}

function parseQueueEntry(row: DeliveryQueueEntryJsonRow | undefined): QueuedDelivery | null {
  return parseDeliveryQueueEntryJson(row, isQueuedDelivery);
}

function loadQueueEntryByStatus(
  id: string,
  status: "pending" | "failed",
  stateDir?: string,
): QueuedDelivery | null {
  const stateDatabase = openOpenClawStateDatabase(databaseOptions(stateDir));
  const db = getNodeSqliteKysely<DeliveryQueueDatabase>(stateDatabase.db);
  const row = executeSqliteQueryTakeFirstSync(
    stateDatabase.db,
    db
      .selectFrom("delivery_queue_entries")
      .select(["entry_json"])
      .where("queue_name", "=", QUEUE_NAME)
      .where("id", "=", id)
      .where("status", "=", status),
  );
  return parseQueueEntry(row);
}

function persistQueueEntry(entry: QueuedDelivery, stateDir?: string): void {
  const now = Date.now();
  runOpenClawStateWriteTransaction((stateDatabase) => {
    const db = getNodeSqliteKysely<DeliveryQueueDatabase>(stateDatabase.db);
    executeSqliteQuerySync(
      stateDatabase.db,
      db
        .updateTable("delivery_queue_entries")
        .set({
          entry_json: JSON.stringify(entry),
          updated_at: now,
        })
        .where("queue_name", "=", QUEUE_NAME)
        .where("id", "=", entry.id)
        .where("status", "=", "pending"),
    );
  }, databaseOptions(stateDir));
}

function ensureDeliveryQueueStorage(stateDir?: string): void {
  openOpenClawStateDatabase(databaseOptions(stateDir));
}

/** Persist a delivery entry before attempting send. Returns the entry ID. */
export async function enqueueDelivery(
  params: QueuedDeliveryPayload,
  stateDir?: string,
): Promise<string> {
  ensureDeliveryQueueStorage(stateDir);
  const id = generateSecureUuid();
  const entry: QueuedDelivery = {
    id,
    enqueuedAt: Date.now(),
    channel: params.channel,
    to: params.to,
    accountId: params.accountId,
    payloads: params.payloads,
    renderedBatchPlan: params.renderedBatchPlan,
    threadId: params.threadId,
    replyToId: params.replyToId,
    replyToMode: params.replyToMode,
    formatting: params.formatting,
    identity: params.identity,
    bestEffort: params.bestEffort,
    gifPlayback: params.gifPlayback,
    forceDocument: params.forceDocument,
    silent: params.silent,
    mirror: params.mirror,
    session: params.session,
    gatewayClientScopes: params.gatewayClientScopes,
    retryCount: 0,
  };
  runOpenClawStateWriteTransaction((stateDatabase) => {
    const db = getNodeSqliteKysely<DeliveryQueueDatabase>(stateDatabase.db);
    executeSqliteQuerySync(
      stateDatabase.db,
      db.insertInto("delivery_queue_entries").values({
        queue_name: QUEUE_NAME,
        id,
        status: "pending",
        entry_json: JSON.stringify(entry),
        enqueued_at: entry.enqueuedAt,
        updated_at: Date.now(),
        failed_at: null,
      }),
    );
  }, databaseOptions(stateDir));
  return id;
}

/** Remove a successfully delivered entry from the queue. */
export async function ackDelivery(id: string, stateDir?: string): Promise<void> {
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

/** Update a queue entry after a failed delivery attempt. */
export async function failDelivery(id: string, error: string, stateDir?: string): Promise<void> {
  const entry = await loadPendingDelivery(id, stateDir);
  if (!entry) {
    throw createMissingQueueEntryError(id);
  }
  entry.retryCount += 1;
  entry.lastAttemptAt = Date.now();
  entry.lastError = error;
  persistQueueEntry(entry, stateDir);
}

export async function markDeliveryPlatformSendAttemptStarted(
  id: string,
  stateDir?: string,
): Promise<void> {
  const entry = await loadPendingDelivery(id, stateDir);
  if (!entry) {
    throw createMissingQueueEntryError(id);
  }
  entry.platformSendStartedAt = entry.platformSendStartedAt ?? Date.now();
  entry.recoveryState = "send_attempt_started";
  persistQueueEntry(entry, stateDir);
}

export async function markDeliveryPlatformOutcomeUnknown(
  id: string,
  stateDir?: string,
): Promise<void> {
  const entry = await loadPendingDelivery(id, stateDir);
  if (!entry) {
    throw createMissingQueueEntryError(id);
  }
  entry.platformSendStartedAt = entry.platformSendStartedAt ?? Date.now();
  entry.recoveryState = "unknown_after_send";
  persistQueueEntry(entry, stateDir);
}

export async function loadPendingDelivery(
  id: string,
  stateDir?: string,
): Promise<QueuedDelivery | null> {
  const entry = loadQueueEntryByStatus(id, "pending", stateDir);
  if (!entry) {
    return null;
  }
  const normalized = normalizeLegacyQueuedDeliveryEntry(entry);
  if (normalized.migrated) {
    persistQueueEntry(normalized.entry, stateDir);
  }
  return normalized.entry;
}

export async function loadPendingDeliveries(stateDir?: string): Promise<QueuedDelivery[]> {
  const stateDatabase = openOpenClawStateDatabase(databaseOptions(stateDir));
  const db = getNodeSqliteKysely<DeliveryQueueDatabase>(stateDatabase.db);
  const rows = executeSqliteQuerySync(
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
    .filter((entry): entry is QueuedDelivery => entry !== null)
    .map((entry) => {
      const normalized = normalizeLegacyQueuedDeliveryEntry(entry);
      if (normalized.migrated) {
        persistQueueEntry(normalized.entry, stateDir);
      }
      return normalized.entry;
    });
}

/** Move a queue entry to failed status. */
export async function moveToFailed(id: string, stateDir?: string): Promise<void> {
  const entry = await loadPendingDelivery(id, stateDir);
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

export async function loadFailedDeliveryForTest(
  id: string,
  stateDir?: string,
): Promise<QueuedDelivery | null> {
  return loadQueueEntryByStatus(id, "failed", stateDir);
}
