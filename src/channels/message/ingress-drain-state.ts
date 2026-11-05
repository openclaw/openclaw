import { hasSqliteWorkerOutcomeUnknown } from "../../infra/sqlite-worker-contract.js";
import type {
  ChannelIngressQueue,
  ChannelIngressQueueClaim,
  ChannelIngressQueueRecord,
} from "./ingress-queue.types.js";

export class IngressAdoptionLostError extends Error {
  readonly code: "guillotined" | "superseded" | "reclaimed";

  constructor(code: "guillotined" | "superseded" | "reclaimed") {
    super(`ingress adoption lost: ${code}`);
    this.name = "IngressAdoptionLostError";
    this.code = code;
  }
}

export function isIngressAdoptionLostError(error: unknown): error is IngressAdoptionLostError {
  return error instanceof IngressAdoptionLostError;
}

export type ChannelIngressDrainDispatchResult =
  | { kind: "completed" }
  /** The dispatch owner already committed this claim to its durable receipt. */
  | { kind: "transferred" }
  /** Normal admission backpressure; the caller owns the next wake. */
  | { kind: "pending" }
  | { kind: "deferred" }
  | { kind: "failed-retryable"; error: unknown };

export type ActiveHandlerState<TPayload, TMetadata> = {
  eventId: string;
  laneKey: string;
  claim: ChannelIngressQueueClaim<TPayload, TMetadata>;
  abortController: AbortController;
  startedAt: number;
  phase: "dispatching" | "deferred" | "adopted" | "failed" | "settled";
  occupiesLane: boolean;
  task: Promise<void>;
  settlement?: Promise<void>;
  settlementFailure?: { error: unknown };
  stallTimer?: ReturnType<typeof setTimeout>;
  claimRefreshTimer?: ReturnType<typeof setInterval>;
  /** Closed code: pre-adoption stall watchdog has claimed settle ownership. */
  guillotined: boolean;
  /** Closed code: pre-adoption supersede has claimed settle ownership. */
  superseded: boolean;
  /** Single settle owner for complete / fail / release / supersede / guillotine. */
  settleOnce: (fn: () => Promise<void>) => Promise<void>;
};

export function clearIngressClaimRefresh<TPayload, TMetadata>(
  state: ActiveHandlerState<TPayload, TMetadata>,
): void {
  clearInterval(state.claimRefreshTimer);
  state.claimRefreshTimer = undefined;
}

export function armIngressClaimRefresh<TPayload, TMetadata>(
  state: ActiveHandlerState<TPayload, TMetadata>,
  {
    queue,
    claimLeaseMs,
    now,
    onReclaimed,
    log,
    formatError,
  }: {
    queue: Pick<ChannelIngressQueue<TPayload, TMetadata>, "refreshClaim">;
    claimLeaseMs: number;
    now: () => number;
    onReclaimed: (state: ActiveHandlerState<TPayload, TMetadata>) => void;
    log: (message: string) => void;
    formatError: (error: unknown) => string;
  },
): void {
  clearIngressClaimRefresh(state);
  // Keep lease alive until tombstone commits (includes complete-retry wedge).
  const intervalMs = Math.max(1, Math.floor(claimLeaseMs / 3));
  state.claimRefreshTimer = setInterval(() => {
    if (state.phase === "settled" || state.guillotined || state.superseded) {
      clearIngressClaimRefresh(state);
      return;
    }
    void (async () => {
      if (queue.refreshClaim) {
        const refreshed = await queue.refreshClaim(state.claim, { refreshedAt: now() });
        // false = claim-token fence rejected (lease reclaimed by another owner).
        if (!refreshed) {
          onReclaimed(state);
        }
      }
    })().catch((err: unknown) => {
      try {
        log(
          `ingress drain: claim refresh failed for event ${state.claim.id}; holding claim: ${formatError(err)}`,
        );
      } catch {
        // A retiring observer cannot turn a failed heartbeat into an unhandled rejection.
      }
    });
  }, intervalMs);
  state.claimRefreshTimer.unref?.();
}

export function isPreAdoptionState<TPayload, TMetadata>(
  state: ActiveHandlerState<TPayload, TMetadata>,
): boolean {
  return (
    (state.phase === "dispatching" || state.phase === "deferred") &&
    !state.guillotined &&
    !state.superseded
  );
}

export function createIngressSettleOwner<TPayload, TMetadata>(
  state: ActiveHandlerState<TPayload, TMetadata>,
  removeActive: (state: ActiveHandlerState<TPayload, TMetadata>) => void,
): (fn: () => Promise<void>) => Promise<void> {
  let settlePromise: Promise<void> | undefined;
  return async (fn) => {
    if (state.phase === "settled") {
      return;
    }
    if (settlePromise) {
      return settlePromise;
    }
    settlePromise = Promise.resolve().then(async () => {
      try {
        // Only mark settled after the tombstone/fail/release write commits.
        // Write failure must keep heartbeat + in-memory ownership (wedged > duplicated).
        await fn();
        state.settlementFailure = undefined;
        state.phase = "settled";
        removeActive(state);
      } catch (error) {
        state.settlementFailure = isIngressAdoptionLostError(error) ? undefined : { error };
        throw error;
      } finally {
        state.settlement = undefined;
      }
    });
    state.settlement = settlePromise;
    try {
      await settlePromise;
    } catch (err) {
      if (!hasSqliteWorkerOutcomeUnknown(err)) {
        settlePromise = undefined;
      }
      throw err;
    }
  };
}

export function activeClaimKey<TPayload, TMetadata>(
  claim: ChannelIngressQueueClaim<TPayload, TMetadata>,
): string {
  return `${claim.id}\0${claim.claim.token}`;
}

export function resolveLaneKey<TPayload, TMetadata>(
  record: ChannelIngressQueueRecord<TPayload, TMetadata>,
  deriveLaneKey?: (record: ChannelIngressQueueRecord<TPayload, TMetadata>) => string | undefined,
  reconcileStoredLaneKey?: (
    record: ChannelIngressQueueRecord<TPayload, TMetadata>,
    storedLaneKey: string,
    derivedLaneKey: string,
  ) => boolean,
): string {
  const derivedLaneKey = deriveLaneKey?.(record);
  const storedLaneKey = record.laneKey;
  if (
    !reconcileStoredLaneKey ||
    storedLaneKey === undefined ||
    derivedLaneKey === undefined ||
    storedLaneKey === derivedLaneKey
  ) {
    return derivedLaneKey ?? storedLaneKey ?? record.id;
  }
  return reconcileStoredLaneKey(record, storedLaneKey, derivedLaneKey)
    ? derivedLaneKey
    : storedLaneKey;
}
