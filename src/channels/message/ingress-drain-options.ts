/** Options for createChannelIngressDrain; ingress-drain.ts re-exports them. */
import type { ChannelIngressDispatchLifecycle } from "./ingress-drain-lifecycle.js";
import type { ResolveChannelIngressPendingDisposition } from "./ingress-drain-pending-disposition.js";
import type { ChannelIngressDrainDispatchResult } from "./ingress-drain-state.js";
import type { IngressSupersedeDecision } from "./ingress-drain-supersede.js";
import type {
  ChannelIngressQueue,
  ChannelIngressQueueClaim,
  ChannelIngressQueueRecord,
} from "./ingress-queue.types.js";
import type {
  IngressNonRetryableFailure,
  IngressRetryPolicyConfig,
} from "./ingress-retry-policy.js";

type DeferredLaneOccupancy = "hold" | "release";

export type CreateChannelIngressDrainOptions<
  TPayload,
  TMetadata = unknown,
  TCompletedMetadata = unknown,
> = {
  queue: ChannelIngressQueue<TPayload, TMetadata, TCompletedMetadata>;
  /**
   * Dispatch a claimed event. Wire lifecycle into reply options (see
   * bindIngressLifecycleToReplyOptions). Return deferred when ownership will
   * transfer at reply-lane admission; otherwise complete or throw.
   */
  dispatchClaimedEvent: (
    event: ChannelIngressQueueClaim<TPayload, TMetadata>,
    lifecycle: ChannelIngressDispatchLifecycle,
  ) => Promise<ChannelIngressDrainDispatchResult | void> | ChannelIngressDrainDispatchResult | void;
  resolveNonRetryableFailure?: (err: unknown) => IngressNonRetryableFailure | null;
  /** A returned guard is checked synchronously before cancelling pre-adoption work. */
  shouldSupersedePending?: (
    newEvent:
      | ChannelIngressQueueRecord<TPayload, TMetadata>
      | ChannelIngressQueueClaim<TPayload, TMetadata>,
    pendingEvent: ChannelIngressQueueClaim<TPayload, TMetadata>,
  ) => IngressSupersedeDecision | Promise<IngressSupersedeDecision>;
  deriveLaneKey?: (record: ChannelIngressQueueRecord<TPayload, TMetadata>) => string | undefined;
  reconcileStoredLaneKey?: (
    record: ChannelIngressQueueRecord<TPayload, TMetadata>,
    storedLaneKey: string,
    derivedLaneKey: string,
  ) => boolean;
  /**
   * Optional channel policy that may terminally fail or hold a stored pending
   * row before it is claimed. Return null/undefined to keep the row claimable.
   */
  resolvePendingDisposition?: ResolveChannelIngressPendingDisposition<TPayload, TMetadata>;
  ownerId?: string;
  adoptionStallTimeoutMs?: number;
  claimLeaseMs?: number;
  /**
   * Whether a claimed event keeps occupying its ingress serialization lane after
   * dispatch hands ownership to deferred work. Default "hold" (current behavior).
   */
  deferredLaneOccupancy?: DeferredLaneOccupancy;
  retryPolicy?: IngressRetryPolicyConfig;
  now?: () => number;
  formatError?: (err: unknown) => string;
  onLog?: (message: string) => void;
  abortSignal?: AbortSignal;
  orderBy?: "received" | "id";
  scanLimit?: number;
  startLimit?: number;
};
