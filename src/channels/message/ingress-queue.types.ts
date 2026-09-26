import type { Selectable } from "kysely";
import type { ChannelIngressEvents } from "../../state/openclaw-state-db.generated.js";

/** Pending or retryable inbound channel event stored in the durable ingress queue. */
export type ChannelIngressQueueRecord<TPayload, TMetadata = unknown> = {
  id: string;
  channelId: string;
  accountId: string;
  queueName: string;
  payload: TPayload;
  metadata?: TMetadata;
  receivedAt: number;
  updatedAt: number;
  laneKey?: string;
  attempts: number;
  lastAttemptAt?: number;
  lastError?: string;
};

/** Pending ingress event currently claimed by a worker. */
export type ChannelIngressQueueClaim<TPayload, TMetadata = unknown> = ChannelIngressQueueRecord<
  TPayload,
  TMetadata
> & {
  claim: {
    token: string;
    ownerId: string;
    claimedAt: number;
  };
};

/** Minimal claim reference used to guard completion/release/failure with a claim token. */
export type ChannelIngressQueueClaimRef = {
  id: string;
  claim: {
    token: string;
  };
};

/** Claim identity available when a stale row's payload cannot be decoded. */
export type ChannelIngressQueueCorruptClaim = {
  id: string;
  channelId: string;
  accountId: string;
  queueName: string;
  laneKey?: string;
  reason: "corrupt_payload";
  claim: {
    token: string;
    ownerId: string;
    claimedAt: number;
  };
};

/** Completed ingress event tombstone retained for duplicate detection. */
export type ChannelIngressQueueCompletedRecord<TCompletedMetadata = unknown> = {
  id: string;
  channelId: string;
  accountId: string;
  queueName: string;
  completedAt: number;
  metadata?: TCompletedMetadata;
};

/** Retention options for pending, completed, and failed ingress queue rows. */
export type ChannelIngressQueuePruneOptions = {
  pendingTtlMs?: number;
  completedTtlMs?: number;
  failedTtlMs?: number;
  pendingMaxEntries?: number;
  completedMaxEntries?: number;
  failedMaxEntries?: number;
  protectIds?: Iterable<string>;
  now?: number;
};

/** Failed ingress event tombstone retained for duplicate detection. */
type ChannelIngressQueueFailedRecord = {
  id: string;
  channelId: string;
  accountId: string;
  queueName: string;
  failedAt: number;
  reason: string;
  message?: string;
};

/** Rich failed ingress event retained for diagnostics and operator recovery. */
export type ChannelIngressQueueDeadLetterRecord<
  TPayload = unknown,
  TMetadata = unknown,
> = ChannelIngressQueueFailedRecord & {
  payload?: TPayload;
  metadata?: TMetadata;
  receivedAt: number;
  updatedAt: number;
  laneKey?: string;
  attempts: number;
  lastAttemptAt?: number;
};

/** Outcome of asking a channel/account queue to re-enqueue one failed event. */
type ChannelIngressQueueResubmitResult<
  TPayload,
  TMetadata = unknown,
  TCompletedMetadata = unknown,
> =
  | {
      kind: "resubmitted";
      record: ChannelIngressQueueRecord<TPayload, TMetadata>;
      previous: ChannelIngressQueueDeadLetterRecord<TPayload, TMetadata>;
    }
  | { kind: "not-found" }
  | {
      kind: "completed";
      record: ChannelIngressQueueCompletedRecord<TCompletedMetadata>;
    }
  | { kind: "active"; status: "pending" | "claimed" }
  | {
      kind: "unrecoverable";
      record: ChannelIngressQueueDeadLetterRecord<TPayload, TMetadata>;
    };

/** Result of enqueueing a possibly duplicate ingress event id. */
type ChannelIngressQueueEnqueueResult<TPayload, TMetadata, TCompletedMetadata> =
  | {
      kind: "accepted";
      duplicate: false;
      record: ChannelIngressQueueRecord<TPayload, TMetadata>;
    }
  | {
      kind: "pending";
      duplicate: true;
      record: ChannelIngressQueueRecord<TPayload, TMetadata>;
    }
  | {
      kind: "claimed";
      duplicate: true;
      record: ChannelIngressQueueClaim<TPayload, TMetadata>;
    }
  | {
      kind: "completed";
      duplicate: true;
      record: ChannelIngressQueueCompletedRecord<TCompletedMetadata>;
    }
  | {
      kind: "failed";
      duplicate: true;
      record: ChannelIngressQueueFailedRecord;
    };

/** Durable FIFO-ish ingress queue with claims, duplicate detection, and retention pruning. */
export type ChannelIngressQueue<TPayload, TMetadata = unknown, TCompletedMetadata = unknown> = {
  enqueue(
    id: string,
    payload: TPayload,
    options?: {
      metadata?: TMetadata;
      receivedAt?: number;
      laneKey?: string;
    },
  ): Promise<ChannelIngressQueueEnqueueResult<TPayload, TMetadata, TCompletedMetadata>>;
  listPending(options?: {
    limit?: number | "all";
    orderBy?: "received" | "id";
  }): Promise<Array<ChannelIngressQueueRecord<TPayload, TMetadata>>>;
  listClaims(): Promise<Array<ChannelIngressQueueClaim<TPayload, TMetadata>>>;
  /** Coherent lane state; optional for existing external queue implementations. */
  listUnsettled?(options?: { orderBy?: "received" | "id" }): Promise<{
    pending: Array<ChannelIngressQueueRecord<TPayload, TMetadata>>;
    claims: Array<ChannelIngressQueueClaim<TPayload, TMetadata>>;
  }>;
  /** Additive SDK seam; optional so existing external queue test doubles remain compatible. */
  listFailed?(options?: {
    limit?: number | "all";
  }): Promise<Array<ChannelIngressQueueDeadLetterRecord<TPayload, TMetadata>>>;
  claimNext(options?: {
    ownerId?: string;
    blockedLaneKeys?: Iterable<string>;
    staleMs?: number;
    orderBy?: "received" | "id";
    scanLimit?: number;
    candidateIds?: Iterable<string>;
    deriveLaneKey?: (record: ChannelIngressQueueRecord<TPayload, TMetadata>) => string | undefined;
    /** Authorize a changed durable lane before the atomic pending-to-claimed transition. */
    reconcileStoredLaneKey?: (
      record: ChannelIngressQueueRecord<TPayload, TMetadata>,
      storedLaneKey: string,
      derivedLaneKey: string,
    ) => boolean;
  }): Promise<ChannelIngressQueueClaim<TPayload, TMetadata> | null>;
  claim(
    id: string,
    options?: { ownerId?: string },
  ): Promise<ChannelIngressQueueClaim<TPayload, TMetadata> | null>;
  refreshClaim?(
    claim: ChannelIngressQueueClaimRef,
    options?: { refreshedAt?: number },
  ): Promise<boolean>;
  complete(
    idOrClaim: string | ChannelIngressQueueClaimRef,
    options?: { metadata?: TCompletedMetadata; completedAt?: number },
  ): Promise<boolean>;
  release(
    idOrClaim: string | ChannelIngressQueueClaimRef,
    options?: { lastError?: string; releasedAt?: number; recordAttempt?: boolean },
  ): Promise<boolean>;
  fail(
    idOrClaim: string | ChannelIngressQueueClaimRef,
    options: { reason: string; message?: string; failedAt?: number },
  ): Promise<boolean>;
  /** Additive SDK seam; actual runtime queues support operator resubmission. */
  resubmit?(
    id: string,
    options?: { resubmittedAt?: number },
  ): Promise<ChannelIngressQueueResubmitResult<TPayload, TMetadata, TCompletedMetadata>>;
  delete(
    idOrClaim:
      | string
      | ChannelIngressQueueRecord<TPayload, TMetadata>
      | ChannelIngressQueueClaimRef,
  ): Promise<boolean>;
  recoverStaleClaims(options?: {
    staleMs?: number;
    now?: number;
    shouldRecover?: (
      claim: ChannelIngressQueueClaim<TPayload, TMetadata>,
    ) => boolean | Promise<boolean>;
    shouldRecoverCorrupt?: (claim: ChannelIngressQueueCorruptClaim) => boolean | Promise<boolean>;
  }): Promise<number>;
  prune(options?: ChannelIngressQueuePruneOptions): Promise<number>;
  /**
   * Delete all rows after callers stop the account's producers and drain.
   * Optional for existing plugin-supplied queue inputs; core queues implement it.
   * Cancellation before commit admission preserves every row.
   */
  purge?(options?: { signal?: AbortSignal }): Promise<number>;
};

/** Construction options for a channel/account-scoped ingress queue. */
export type CreateChannelIngressQueueOptions = {
  channelId: string;
  accountId?: string;
  stateDir?: string;
  now?: () => number;
  /**
   * Read-only inspection never creates, migrates, chmods, or configures the shared
   * state file. Read-write listings retain canonical database admission.
   */
  access?: "read-write" | "read-only";
};

export type ChannelIngressRow = Selectable<ChannelIngressEvents>;
export type ChannelIngressScope = { channelId: string; accountId: string; queueName: string };

export type ChannelIngressListInput = {
  queueName: string;
  status: "pending" | "claimed" | "failed" | "unsettled";
  limit?: number | "all";
  orderBy?: "received" | "id";
};
export type ChannelIngressClaimRequest = {
  queueName: string;
  candidateIds?: string[];
  blockedLaneKeys: string[];
  deriveLaneKey: boolean;
  scanLimit?: number;
  orderBy?: "received" | "id";
};
export type ChannelIngressClaimSnapshot = {
  pending: ChannelIngressRow[];
  claimed: ChannelIngressRow[];
};

export type ChannelIngressClaimSelection = {
  corruptIds: string[];
  selected?: { id: string; laneKey?: string };
};
