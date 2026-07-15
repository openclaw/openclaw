// Persists queued session deliveries for retry and recovery.
import type { SourceReplyDeliveryMode } from "../auto-reply/get-reply-options.types.js";
import type { ChatType } from "../channels/chat-type.js";
import type { InputProvenance } from "../sessions/input-provenance.js";
import { sha256Hex } from "./crypto-digest.js";
import {
  completeDeliveryQueueEntry,
  getDeliveryQueueEntryStatus,
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
      inputProvenance?: InputProvenance;
      sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
      expectedMediaUrls?: string[];
      suppressTextDelivery?: true;
      idempotencyKey?: string;
    } & SessionDeliveryRetryPolicy);

export type QueuedSessionDelivery = QueuedSessionDeliveryPayload & {
  id: string;
  enqueuedAt: number;
  agentRunAttempt?: number;
  retryCount: number;
  lastAttemptAt?: number;
  lastError?: string;
  acknowledgedAt?: number;
  availableAt?: number;
};

export class SessionDeliveryDeferredError extends Error {
  override name = "SessionDeliveryDeferredError";
}

/** Signals that delivery was deliberately moved to failed and must not be retried or acknowledged. */
export class SessionDeliveryDeadLetteredError extends Error {
  override name = "SessionDeliveryDeadLetteredError";
}

function buildEntryId(idempotencyKey?: string): string {
  if (!idempotencyKey) {
    return generateSecureUuid();
  }
  return sha256Hex(idempotencyKey);
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
    reviveFailedOrCorruptPending: Boolean(params.idempotencyKey),
  });
  return id;
}

/** Enqueue and lease the first attempt to one caller before recovery can see it as eligible. */
export async function enqueueClaimedSessionDelivery(
  params: QueuedSessionDeliveryPayload,
  initialAttemptLeaseMs: number,
  stateDir?: string,
): Promise<{
  id: string;
  claimed: boolean;
  status: "pending" | "failed" | "completed" | "unknown";
}> {
  const id = buildEntryId(params.idempotencyKey);
  const entry: QueuedSessionDelivery = {
    ...params,
    id,
    enqueuedAt: Date.now(),
    retryCount: 0,
    availableAt: Date.now() + Math.max(0, initialAttemptLeaseMs),
  };
  const claimed = upsertDeliveryQueueEntry({
    queueName: QUEUE_NAME,
    entry,
    metadata: queuedSessionDeliveryMetadata(entry),
    stateDir,
    insertOnly: true,
  });
  let status: "pending" | "failed" | "completed" | undefined;
  try {
    status = claimed ? "pending" : getDeliveryQueueEntryStatus(QUEUE_NAME, id, stateDir);
  } catch {
    // The insert-only conflict already proved another durable owner existed.
    // Preserve that ownership when diagnostics are temporarily unreadable.
    return { id, claimed, status: "unknown" };
  }
  // Old databases may still delete an acknowledged row between the conflict
  // and lookup. Treat that race like the explicit completed tombstone.
  return { id, claimed, status: status ?? "completed" };
}

/** Release the initial-attempt lease so runtime recovery can retry immediately. */
export async function releaseSessionDeliveryClaim(id: string, stateDir?: string): Promise<void> {
  updateDeliveryQueueEntry(QUEUE_NAME, id, stateDir, (entry) => ({
    ...entry,
    availableAt: Date.now(),
  }));
}

/** Defer a currently owned delivery without consuming its retry budget. */
export async function deferSessionDelivery(
  id: string,
  delayMs: number,
  stateDir?: string,
): Promise<void> {
  updateDeliveryQueueEntry(QUEUE_NAME, id, stateDir, (entry) => ({
    ...entry,
    availableAt: Date.now() + Math.max(0, delayMs),
  }));
}

/** Advance only after a completed agent turn proves a fresh run is safe. */
export async function advanceSessionDeliveryAgentRun(
  id: string,
  updates?: { expectedMediaUrls?: string[]; message?: string; suppressTextDelivery?: boolean },
  stateDir?: string,
): Promise<void> {
  updateDeliveryQueueEntry(QUEUE_NAME, id, stateDir, (entry) => {
    const queued = entry as QueuedSessionDelivery;
    if (queued.kind !== "agentTurn") {
      return queued;
    }
    return {
      ...queued,
      agentRunAttempt: (queued.agentRunAttempt ?? 0) + 1,
      ...(updates?.message ? { message: updates.message } : {}),
      ...(updates?.expectedMediaUrls ? { expectedMediaUrls: updates.expectedMediaUrls } : {}),
      ...(updates?.suppressTextDelivery === true ? { suppressTextDelivery: true as const } : {}),
    };
  });
}

/** Acknowledge a successfully delivered session entry. */
export class SessionDeliveryAcknowledgementFinalizeError extends Error {
  constructor(id: string, options?: ErrorOptions) {
    super(`Acknowledged session delivery ${id} still needs tombstone finalization`, options);
    this.name = "SessionDeliveryAcknowledgementFinalizeError";
  }
}

export async function ackSessionDelivery(id: string, stateDir?: string): Promise<void> {
  const entry = loadDeliveryQueueEntry(QUEUE_NAME, id, stateDir) as QueuedSessionDelivery | null;
  if (!entry) {
    return;
  }
  try {
    if (!entry.acknowledgedAt) {
      updateDeliveryQueueEntry(QUEUE_NAME, id, stateDir, (current) => ({
        ...current,
        acknowledgedAt: Date.now(),
      }));
    }
    completeDeliveryQueueEntry(QUEUE_NAME, id, stateDir);
  } catch (error) {
    try {
      if (getDeliveryQueueEntryStatus(QUEUE_NAME, id, stateDir) === "completed") {
        return;
      }
    } catch {
      // Unprovable state remains acknowledgement finalization, never a delivery retry.
    }
    throw new SessionDeliveryAcknowledgementFinalizeError(id, { cause: error });
  }
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
