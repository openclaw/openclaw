/** Contracts and active-claim state for the durable ingress drain. */
import type {
  ChannelIngressQueue,
  ChannelIngressQueueClaim,
  ChannelIngressQueueRecord,
} from "./ingress-queue.js";
import type {
  IngressNonRetryableFailure,
  IngressRetryPolicyConfig,
} from "./ingress-retry-policy.js";

/**
 * Closed error when adoption races a pre-adoption ownership loss. Callers must
 * stop the turn; the drain also aborts its signal when applicable.
 */
export class IngressAdoptionLostError extends Error {
  readonly code: "backpressured" | "guillotined" | "superseded" | "reclaimed";

  constructor(code: "backpressured" | "guillotined" | "superseded" | "reclaimed") {
    super(`ingress adoption lost: ${code}`);
    this.name = "IngressAdoptionLostError";
    this.code = code;
  }
}

export function isIngressAdoptionLostError(error: unknown): error is IngressAdoptionLostError {
  return error instanceof IngressAdoptionLostError;
}

export type ChannelIngressBackpressureParticipant = {
  onBackpressured?: (error: Error) => void | Promise<void>;
  onAbandoned?: () => void | Promise<void>;
};

function throwIngressFanoutFailures(results: readonly PromiseSettledResult<void>[], label: string) {
  const failures = results
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason);
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, `${label} cleanup failed`);
  }
}

/** Wait for every abandonment participant before exposing completion. */
export async function settleChannelIngressAbandonment(
  lifecycles: readonly ChannelIngressBackpressureParticipant[],
  label: string,
): Promise<void> {
  const results = await Promise.allSettled(
    lifecycles.map(async (lifecycle) => await lifecycle.onAbandoned?.()),
  );
  throwIngressFanoutFailures(results, label);
}

/** Settle every fanout participant, falling back to abandonment per failed/legacy child. */
export async function settleChannelIngressBackpressure(
  lifecycles: readonly ChannelIngressBackpressureParticipant[],
  error: Error,
  label: string,
): Promise<void> {
  const results = await Promise.allSettled(
    lifecycles.map(async (lifecycle) => {
      if (!lifecycle.onBackpressured) {
        await lifecycle.onAbandoned?.();
        return;
      }
      try {
        await lifecycle.onBackpressured(error);
      } catch {
        await lifecycle.onAbandoned?.();
      }
    }),
  );
  throwIngressFanoutFailures(results, `${label} backpressure`);
}

/** Full pre-adoption → adoption ownership lifecycle for one claimed event. */
export type ChannelIngressDispatchLifecycle = {
  /** Pre-adoption only. After adopt the drain treats this signal as inert. */
  abortSignal: AbortSignal;
  /** Recovery-relevant session/run state is durable; tombstone the claim. */
  onAdopted: () => void | Promise<void>;
  /** Turn ownership moved to later reply-lane admission. */
  onDeferred: () => void;
  /** Queue capacity rejected the exact durable payload before admission. */
  onBackpressured: (error: Error) => void | Promise<void>;
  /** Clear the stall watchdog while durable adoption finalization is held. */
  onAdoptionFinalizing: () => void;
  /** Deferred turn ended without reply-lane ownership; release for retry. */
  onAbandoned: () => void | Promise<void>;
};

type ChannelIngressDrainDispatchResult =
  | { kind: "completed" }
  | { kind: "deferred" }
  | { kind: "failed-retryable"; error: unknown };

export type CreateChannelIngressDrainOptions<
  TPayload,
  TMetadata = unknown,
  TCompletedMetadata = unknown,
> = {
  queue: ChannelIngressQueue<TPayload, TMetadata, TCompletedMetadata>;
  dispatchClaimedEvent: (
    event: ChannelIngressQueueClaim<TPayload, TMetadata>,
    lifecycle: ChannelIngressDispatchLifecycle,
  ) => Promise<ChannelIngressDrainDispatchResult | void> | ChannelIngressDrainDispatchResult | void;
  resolveNonRetryableFailure?: (err: unknown) => IngressNonRetryableFailure | null;
  shouldSupersedePending?: (
    newEvent:
      | ChannelIngressQueueRecord<TPayload, TMetadata>
      | ChannelIngressQueueClaim<TPayload, TMetadata>,
    pendingEvent: ChannelIngressQueueClaim<TPayload, TMetadata>,
  ) => boolean | Promise<boolean>;
  deriveLaneKey?: (record: ChannelIngressQueueRecord<TPayload, TMetadata>) => string | undefined;
  ownerId?: string;
  adoptionStallTimeoutMs?: number;
  claimLeaseMs?: number;
  retryPolicy?: IngressRetryPolicyConfig;
  now?: () => number;
  formatError?: (err: unknown) => string;
  onLog?: (message: string) => void;
  abortSignal?: AbortSignal;
  orderBy?: "received" | "id";
  scanLimit?: number;
  startLimit?: number;
};

export type ChannelIngressDrain = {
  recoverStaleClaims: () => Promise<number>;
  drainOnce: (options?: { shouldStop?: () => boolean }) => Promise<{ started: number }>;
  activeLaneKeys: () => ReadonlySet<string>;
  waitForIdle: () => Promise<void>;
  dispose: () => void;
};

export type ActiveHandlerState<TPayload, TMetadata> = {
  eventId: string;
  laneKey: string;
  claim: ChannelIngressQueueClaim<TPayload, TMetadata>;
  abortController: AbortController;
  startedAt: number;
  phase: "dispatching" | "deferred" | "backpressured" | "adopted" | "settled";
  task: Promise<void>;
  stallTimer?: ReturnType<typeof setTimeout>;
  claimRefreshTimer?: ReturnType<typeof setInterval>;
  /** Closed code: pre-adoption stall watchdog has claimed settle ownership. */
  guillotined: boolean;
  /** Closed code: pre-adoption supersede has claimed settle ownership. */
  superseded: boolean;
  /** Single settle owner for complete / fail / release / supersede / guillotine. */
  settleOnce: (fn: () => Promise<void>) => Promise<void>;
};
