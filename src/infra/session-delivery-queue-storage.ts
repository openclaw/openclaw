// Persists queued session deliveries for retry and recovery.
import { createHash } from "node:crypto";
import type { ChatType } from "../channels/chat-type.js";
import {
  deleteDeliveryQueueEntry,
  loadDeliveryQueueEntries,
  loadDeliveryQueueEntry,
  moveDeliveryQueueEntryToFailed,
  updateDeliveryQueueEntry,
  upsertDeliveryQueueEntry,
  type DeliveryQueueRowMetadata,
} from "./delivery-queue-sqlite.js";
import { generateSecureUuid } from "./secure-random.js";

// Session delivery queue persists session-scoped messages until channel
// delivery acknowledges them or recovery exhausts retry policy.
const QUEUE_NAME = "session";

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

/** Payload variants that can be replayed by session delivery recovery. */
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
      expectedSessionId?: string;
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
  // Durable recovery marker, persisted on the shared delivery-queue SQLite
  // `recovery_state` column. Set to `send_attempt_started` while a delivery is
  // mid-flight (the drain has begun deliver but not yet acked); a recovered entry
  // carrying it is refused a blind replay (see session-delivery-queue-recovery.ts).
  // Unlike the outbound queue we keep a single state: the drain refuses on this
  // marker alone, so a post-deliver `unknown_after_send` upgrade would change no
  // decision (the in-process `delivered` flag already covers a post-return failure).
  recoveryState?: "send_attempt_started";
};

function buildEntryId(idempotencyKey?: string): string {
  if (!idempotencyKey) {
    return generateSecureUuid();
  }
  return createHash("sha256").update(idempotencyKey).digest("hex");
}

function queuedSessionDeliveryMetadata(entry: QueuedSessionDelivery): DeliveryQueueRowMetadata {
  const route = entry.kind === "agentTurn" ? entry.route : undefined;
  return {
    entryKind: entry.kind,
    sessionKey: entry.sessionKey,
    channel: route?.channel ?? entry.deliveryContext?.channel,
    target: route?.to ?? entry.deliveryContext?.to,
    accountId: route?.accountId ?? entry.deliveryContext?.accountId,
  };
}

/** Enqueue a session delivery and return its durable id. */
export async function enqueueSessionDelivery(
  params: QueuedSessionDeliveryPayload,
  stateDir?: string,
): Promise<string> {
  const id = buildEntryId(params.idempotencyKey);

  if (params.idempotencyKey && loadDeliveryQueueEntry(QUEUE_NAME, id, stateDir)) {
    return id;
  }

  const entry: QueuedSessionDelivery = {
    ...params,
    id,
    enqueuedAt: Date.now(),
    retryCount: 0,
  };
  upsertDeliveryQueueEntry({
    queueName: QUEUE_NAME,
    entry,
    metadata: queuedSessionDeliveryMetadata(entry),
    stateDir,
  });
  return id;
}

/** Acknowledge a successfully delivered session entry. */
export async function ackSessionDelivery(id: string, stateDir?: string): Promise<void> {
  deleteDeliveryQueueEntry(QUEUE_NAME, id, stateDir);
}

/** Record a failed delivery attempt and increment retry metadata. */
export async function failSessionDelivery(
  id: string,
  error: string,
  stateDir?: string,
): Promise<void> {
  updateDeliveryQueueEntry(QUEUE_NAME, id, stateDir, (entry) => {
    const queued = entry as QueuedSessionDelivery;
    return {
      ...queued,
      retryCount: queued.retryCount + 1,
      lastAttemptAt: Date.now(),
      lastError: error,
    };
  });
}

/** Load one pending session delivery by durable id. */
export async function loadPendingSessionDelivery(
  id: string,
  stateDir?: string,
): Promise<QueuedSessionDelivery | null> {
  return loadDeliveryQueueEntry(QUEUE_NAME, id, stateDir) as QueuedSessionDelivery | null;
}

/** Load all pending session deliveries in retry order. */
export async function loadPendingSessionDeliveries(
  stateDir?: string,
): Promise<QueuedSessionDelivery[]> {
  return loadDeliveryQueueEntries(QUEUE_NAME, stateDir) as QueuedSessionDelivery[];
}

/** Move an exhausted session delivery out of the pending queue. */
export async function moveSessionDeliveryToFailed(id: string, stateDir?: string): Promise<void> {
  moveDeliveryQueueEntryToFailed(QUEUE_NAME, id, stateDir);
}

// Persist the send-attempt marker before the drain invokes the deliver seam, so a
// crash anywhere between here and the ack leaves durable evidence that the delivery
// may already have run. Mirrors the outbound queue's send_attempt_started.
export async function markSessionDeliveryPlatformSendAttemptStarted(
  id: string,
  stateDir?: string,
): Promise<void> {
  updateDeliveryQueueEntry(QUEUE_NAME, id, stateDir, (entry) => ({
    ...(entry as QueuedSessionDelivery),
    recoveryState: "send_attempt_started",
  }));
}

// Clear the recovery marker. Used only on a proven pre-send failure (deliver threw
// before anything reached the platform), so the entry stays replayable.
export async function clearSessionDeliveryRecoveryState(
  id: string,
  stateDir?: string,
): Promise<void> {
  updateDeliveryQueueEntry(QUEUE_NAME, id, stateDir, (entry) => ({
    ...(entry as QueuedSessionDelivery),
    recoveryState: undefined,
  }));
}
