import type { Selectable } from "kysely";
import type { ChannelIngressEvents } from "../../state/openclaw-state-db.generated.js";

export type ChannelIngressQueueRecord<TPayload, TMetadata = unknown> = ChannelIngressScope & {
  id: string;
  payload: TPayload;
  metadata?: TMetadata;
  receivedAt: number;
  updatedAt: number;
  laneKey?: string;
  attempts: number;
  lastAttemptAt?: number;
  lastError?: string;
};

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
export type ChannelIngressQueueCorruptClaim = ChannelIngressScope & {
  id: string;
  laneKey?: string;
  reason: "corrupt_payload";
  claim: ChannelIngressQueueClaim<unknown>["claim"];
};

/** Completed ingress event tombstone retained for duplicate detection. */
export type ChannelIngressQueueCompletedRecord<TCompletedMetadata = unknown> =
  ChannelIngressScope & {
    id: string;
    completedAt: number;
    metadata?: TCompletedMetadata;
  };

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
type ChannelIngressQueueFailedRecord = ChannelIngressScope & {
  id: string;
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

type ChannelIngressQueueInput<TPayload, TMetadata> = {
  id: string;
  payload: TPayload;
  metadata?: TMetadata;
  receivedAt?: number;
  laneKey?: string;
};

export type ChannelIngressQueue<TPayload, TMetadata = unknown, TCompletedMetadata = unknown> = {
  /** One durable admission for a transport batch; optional for external queue implementations. */
  enqueueBatch?(
    events: ReadonlyArray<ChannelIngressQueueInput<TPayload, TMetadata>>,
  ): Promise<Array<ChannelIngressQueueEnqueueResult<TPayload, TMetadata, TCompletedMetadata>>>;
  /** Atomic batch admission under current policy authority; absence is unsupported. */
  enqueueBatchAuthorized?(
    events: ReadonlyArray<ChannelIngressQueueInput<TPayload, TMetadata>>,
    options: { assertCurrent: () => void },
  ): Promise<Array<ChannelIngressQueueEnqueueResult<TPayload, TMetadata, TCompletedMetadata>>>;
  /** Claim a fresh singleton only when no pending or claimed row precedes it. */
  enqueueAndClaim?(
    id: string,
    payload: TPayload,
    options: {
      ownerId: string;
      metadata?: TMetadata;
      receivedAt?: number;
      laneKey?: string;
    },
  ): Promise<{
    result: ChannelIngressQueueEnqueueResult<TPayload, TMetadata, TCompletedMetadata>;
    freshClaim?: ChannelIngressQueueClaim<TPayload, TMetadata>;
  }>;
  enqueue(
    id: string,
    payload: TPayload,
    options?: {
      metadata?: TMetadata;
      receivedAt?: number;
      laneKey?: string;
    },
  ): Promise<ChannelIngressQueueEnqueueResult<TPayload, TMetadata, TCompletedMetadata>>;
  /** Current-authority enqueue; absence is unsupported, never fall back to unguarded intake. */
  enqueueAuthorized?: (
    id: string,
    payload: TPayload,
    options: {
      metadata?: TMetadata;
      receivedAt?: number;
      laneKey?: string;
      assertCurrent: () => void;
    },
  ) => Promise<ChannelIngressQueueEnqueueResult<TPayload, TMetadata, TCompletedMetadata>>;
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
    options?: { ownerId?: string; laneKey?: string },
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
  ): Promise<
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
      }
  >;
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
  /** Stored lane keys are authoritative unless a reconcile callback can remap them. */
  reconcileStoredLaneKey?: boolean;
  scanLimit?: number;
  orderBy?: "received" | "id";
  /** Keyset cursor past the last scanned row, used to page beyond a blocked snapshot. */
  claimAfter?: ChannelIngressClaimCursor;
  /**
   * Count of scan-visible pending rows before claimAfter expected by a retained
   * direct-scan resume cursor. The snapshot computes the authoritative count in
   * the same read, so a write from any handle that inserted or removed a row
   * before the cursor invalidates the resume.
   */
  expectedPendingBeforeCursor?: number;
  /**
   * Fingerprint of the scan-visible pending rows before claimAfter expected by a
   * retained direct-scan resume cursor. Combined with expectedPendingBeforeCursor
   * it detects offsetting writes that preserve the count (one row removed and
   * another inserted before the cursor), which count alone cannot observe.
   */
  expectedPendingBeforeCursorFingerprint?: string;
  /**
   * Return the materialized scan-visible prefix rows with the snapshot. Set only
   * on a resumed direct scan whose lane policy is derived: the host re-evaluates
   * each skipped row under the current callback policy, because callback identity
   * cannot prove a captured policy is unchanged.
   */
  includePrefixRows?: boolean;
};
export type ChannelIngressClaimSnapshot = {
  pending: ChannelIngressRow[];
  claimed: ChannelIngressRow[];
  /** Authoritative count of scan-visible pending rows strictly before claimAfter. */
  pendingBeforeCursor?: number;
  /** Fingerprint of the scan-visible pending rows strictly before claimAfter. */
  pendingBeforeCursorFingerprint?: string;
  /**
   * Fingerprint of the pending cursor row itself, read in the same pinned read.
   * The strict-before prefix cannot observe an equal-position replacement of the
   * cursor row, so resuming validates it separately.
   */
  cursorRowFingerprint?: string;
  /**
   * The materialized pending cursor row, present only when the request set
   * includePrefixRows so the host can re-evaluate its lane under current policy.
   */
  cursorRow?: ChannelIngressRow;
  /** Materialized prefix rows, present only when the request set includePrefixRows. */
  prefixRows?: ChannelIngressRow[];
};

/** Keyset cursor matching the pending ordering; the row after it opens the next claim page. */
export type ChannelIngressClaimCursor = {
  receivedAt: number;
  eventId: string;
};

export type ChannelIngressClaimSelection = {
  corruptIds: string[];
  selected?: { id: string; laneKey?: string };
  /** The snapshot consumed its full allowance with no eligible row; another page may exist. */
  more?: boolean;
};
