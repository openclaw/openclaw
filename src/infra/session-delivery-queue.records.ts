import { sha256Hex } from "./crypto-digest.js";
import { generateSecureUuid } from "./secure-random.js";
import type {
  QueuedSessionDelivery as CoreQueuedSessionDelivery,
  QueuedSessionDeliveryPayload as CoreQueuedSessionDeliveryPayload,
} from "./session-delivery-queue-codec.js";

// Session delivery queue persists session-scoped messages until channel
// delivery acknowledges them or recovery exhausts retry policy.
export const SESSION_DELIVERY_QUEUE_NAME = "session";

export type {
  SessionDeliveryContext,
  SessionDeliveryRequesterBinding,
  SessionDeliveryRoute,
  SessionDeliverySettledOutcome,
} from "./session-delivery-queue-codec.js";

export type QueuedSessionDeliveryPayload =
  | (Extract<CoreQueuedSessionDeliveryPayload, { kind: "systemEvent" }> & {
      /** Preserves ownership when a durable event targets the literal global session. */
      agentId?: string;
    })
  | Exclude<CoreQueuedSessionDeliveryPayload, { kind: "systemEvent" }>;

type SessionDeliveryStorageFields = { retainOnFailure?: true };

export type QueuedSessionDelivery =
  | (Extract<CoreQueuedSessionDelivery, { kind: "systemEvent" }> &
      SessionDeliveryStorageFields & { agentId?: string })
  | (Exclude<CoreQueuedSessionDelivery, { kind: "systemEvent" }> & SessionDeliveryStorageFields);

/** Old queued inference remains readable but cannot launch work after restart. */
export function isProducedSessionDelivery(entry: QueuedSessionDelivery): boolean {
  return entry.kind === "agentTurn" && (entry.expectedMediaUrls?.length ?? 0) > 0;
}

/**
 * Continuation-owned rows keep their durable delivery: post-compaction delegates, and system
 * events that settle only on prompt adoption (continuation returns written before that rule are
 * keyed `continuation-return:`). Every other legacy row stays inert like old queued inference.
 */
export function isContinuationSessionDelivery(entry: QueuedSessionDelivery): boolean {
  return (
    entry.kind === "postCompactionDelegate" ||
    (entry.kind === "systemEvent" &&
      (entry.awaitPromptAdoption === true ||
        entry.idempotencyKey?.startsWith("continuation-return:") === true))
  );
}

export function prepareClaimedSessionDelivery(
  params: QueuedSessionDeliveryPayload,
  initialAttemptLeaseMs: number,
  now = Date.now(),
): QueuedSessionDelivery {
  return {
    ...params,
    retainOnFailure: true,
    id: buildEntryId(params.idempotencyKey),
    enqueuedAt: now,
    retryCount: 0,
    availableAt: now + Math.max(0, initialAttemptLeaseMs),
  };
}

/** The target session's system-event queue refused the replay; the row waits for capacity. */
export type SessionDeliveryCapacityDeferral = {
  sessionKey: string;
  continuationReturn: boolean;
};

export class SessionDeliveryDeferredError extends Error {
  override name = "SessionDeliveryDeferredError";
  /** Set only for a capacity refusal, so the retry runtime can back off and report saturation. */
  readonly capacity?: SessionDeliveryCapacityDeferral;
  /**
   * The row's event is queued in memory (or a prepared turn is adopting it):
   * delivery is done and only adoption is outstanding, so the retry runtime
   * leaves the row to its periodic pending sweep instead of polling it.
   */
  readonly awaitingAdoptionInMemory?: true;
  /**
   * Continuation: the row's owner holds it and schedules it on release, so the retry runtime
   * leaves it to the periodic pending sweep instead of polling it.
   */
  readonly heldByOwner?: true;

  constructor(
    message?: string,
    options?: {
      capacity?: SessionDeliveryCapacityDeferral;
      awaitingAdoptionInMemory?: true;
      heldByOwner?: true;
    },
  ) {
    super(message);
    if (options?.capacity) {
      this.capacity = options.capacity;
    }
    if (options?.awaitingAdoptionInMemory) {
      this.awaitingAdoptionInMemory = true;
    }
    if (options?.heldByOwner) {
      this.heldByOwner = true;
    }
  }
}

/** Signals that retry budget was already persisted before a later transition failed. */
export class SessionDeliveryRetryChargedError extends Error {
  override name = "SessionDeliveryRetryChargedError";
}

/** Signals that durable pre-delivery ownership could not be established. */
export class SessionDeliveryAttemptStartError extends Error {
  override name = "SessionDeliveryAttemptStartError";
}

/** Signals that delivery proved no external or transcript side effect committed. */
export class SessionDeliverySafeRetryError extends Error {
  override name = "SessionDeliverySafeRetryError";
}

/** Signals that recovery must settle this pending row as failed without replaying delivery. */
export class SessionDeliveryDeadLetteredError extends Error {
  override name = "SessionDeliveryDeadLetteredError";
  /**
   * The row settles as a bounded `failed` receipt for its id instead of being removed. Only for a
   * decision with no side effect whose cause never reverts: recovery records no settlement first,
   * so a row whose terminal write is lost stays pending and the next replay decides it again.
   */
  readonly keepFailedReceipt?: true;

  constructor(message?: string, options?: { keepFailedReceipt?: true }) {
    super(message);
    if (options?.keepFailedReceipt) {
      this.keepFailedReceipt = true;
    }
  }
}

function buildEntryId(idempotencyKey?: string): string {
  if (!idempotencyKey) {
    return generateSecureUuid();
  }
  return sha256Hex(idempotencyKey);
}

/** Signals that a delivered result still needs durable settlement finalization. */
export class SessionDeliveryAcknowledgementFinalizeError extends Error {
  constructor(id: string, options?: ErrorOptions) {
    super(`Session delivery ${id} still needs settlement finalization`, options);
    this.name = "SessionDeliveryAcknowledgementFinalizeError";
  }
}
