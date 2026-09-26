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

export type ChannelIngressRow = Selectable<ChannelIngressEvents>;
