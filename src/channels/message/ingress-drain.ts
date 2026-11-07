/**
 * Core-owned durable channel-ingress drain.
 *
 * Owns claim recovery, per-lane serialization, adoption-time complete, retry /
 * dead-letter disposition, pre-adoption stall watchdog, and optional supersede.
 */
import { formatErrorMessage, toErrorObject } from "../../infra/errors.js";
import { hasSqliteWorkerOutcomeUnknown } from "../../infra/sqlite-worker-contract.js";
import {
  GatewayDrainingError,
  retainGatewayRootWorkAdmissionContinuation,
  runOutsideGatewayRootWorkAdmission,
} from "../../process/gateway-work-admission.js";
import { runOutsideAsyncWorkScope } from "../../shared/async-work-scope.js";
import {
  createIngressDrainOwnerId,
  deregisterLiveIngressDrainInstance,
  INGRESS_CLAIM_LEASE_MS,
  isIngressClaimOwnedByOtherLiveProcess,
  isIngressCorruptClaimOwnedByOtherLiveProcess,
  isLiveLocalIngressClaim,
  registerLiveIngressDrainInstance,
  retainRetiredIngressClaim,
} from "./ingress-claim-owner.js";
import { createIngressWriter } from "./ingress-claim-writes.js";
import { readIngressBacklogPages, readIngressUnsettled } from "./ingress-drain-backlog.js";
import type { ChannelIngressDispatchLifecycle } from "./ingress-drain-lifecycle.js";
import {
  activeClaimKey,
  armIngressClaimRefresh,
  clearIngressClaimRefresh,
  createIngressSettleOwner,
  IngressAdoptionLostError,
  isPreAdoptionState,
  resolveLaneKey,
  type ActiveHandlerState,
  type ChannelIngressDrainDispatchResult,
} from "./ingress-drain-state.js";
import {
  supersedeActiveStatesIfNeeded,
  type IngressSupersedeDecision,
} from "./ingress-drain-supersede.js";
import {
  createIngressFailureReporter,
  type IngressDeadLetterNotice,
} from "./ingress-failure-report.js";
import { IngressQueueCapDropError, resolveQueueCapDropFailure } from "./ingress-queue-cap-drop.js";
import type {
  ChannelIngressQueue,
  ChannelIngressQueueClaim,
  ChannelIngressQueueRecord,
} from "./ingress-queue.types.js";
import {
  createIngressRetryPolicy,
  type IngressNonRetryableFailure,
  type IngressRetryPolicyConfig,
} from "./ingress-retry-policy.js";
export { bindIngressLifecycleToReplyOptions } from "./ingress-drain-lifecycle.js";
export { isIngressAdoptionLostError } from "./ingress-drain-state.js";

/** Default claim→adoption stall before applying the shared retry disposition. */
export const DEFAULT_INGRESS_ADOPTION_STALL_MS = 5 * 60 * 1000;
export const DEFAULT_INGRESS_START_LIMIT = 32;

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
  /** Best-effort transport notice, only after this claim's dead-letter write commits. */
  onDeadLetter?: IngressDeadLetterNotice<TPayload, TMetadata>;
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
  /** Prefer these pending events without preempting claims or bypassing retry-delayed lanes. */
  prioritizePending?: (record: ChannelIngressQueueRecord<TPayload, TMetadata>) => boolean;
};

export type ChannelIngressDrain = {
  recoverStaleClaims: () => Promise<number>;
  drainOnce: (options?: { shouldStop?: () => boolean }) => Promise<{ started: number }>;
  activeLaneKeys: () => ReadonlySet<string>;
  waitForIdle: () => Promise<void>;
  dispose: () => void;
};

type OwnedChannelIngressDrain = ChannelIngressDrain & {
  dispose(this: void, options: { waitForSettlements: true }): Promise<void>;
};

/** Creates a channel-agnostic durable ingress drain over an existing queue. */
export function createChannelIngressDrain<
  TPayload,
  TMetadata = unknown,
  TCompletedMetadata = unknown,
>(
  options: CreateChannelIngressDrainOptions<TPayload, TMetadata, TCompletedMetadata>,
  retainOwnerUntilDispose = false,
): OwnedChannelIngressDrain {
  const { recoverStaleClaims, drainOnce, activeLaneKeys, waitForIdle, dispose } =
    createChannelIngressDrainOwner(options, retainOwnerUntilDispose);
  return { recoverStaleClaims, drainOnce, activeLaneKeys, waitForIdle, dispose };
}

type ChannelIngressDrainOwnerOptions<TPayload, TMetadata, TCompletedMetadata> = Omit<
  CreateChannelIngressDrainOptions<TPayload, TMetadata, TCompletedMetadata>,
  "dispatchClaimedEvent"
> & {
  onRetryAt?: (retryAt: number | undefined) => void;
  onClaimSettled?: () => void;
  dispatchClaimedEvent: (
    claim: ChannelIngressQueueClaim<TPayload, TMetadata>,
    lifecycle: ChannelIngressDispatchLifecycle,
    admittedLaneKey?: string,
  ) => Promise<ChannelIngressDrainDispatchResult | void> | ChannelIngressDrainDispatchResult | void;
};

/** Core monitor custody; these claim handoff methods are not part of the Plugin SDK. */
export function createChannelIngressDrainOwner<
  TPayload,
  TMetadata = unknown,
  TCompletedMetadata = unknown,
>(
  options: ChannelIngressDrainOwnerOptions<TPayload, TMetadata, TCompletedMetadata>,
  retainOwnerUntilDispose = false,
) {
  const { queue, prioritizePending } = options;
  // Unique per drain instance so same-process peers do not share claim ownership.
  const ownerId = options.ownerId ?? createIngressDrainOwnerId();
  registerLiveIngressDrainInstance(ownerId);
  const adoptionStallTimeoutMs =
    options.adoptionStallTimeoutMs ?? DEFAULT_INGRESS_ADOPTION_STALL_MS;
  const claimLeaseMs = options.claimLeaseMs ?? INGRESS_CLAIM_LEASE_MS;
  const now = options.now ?? Date.now;
  const formatError = options.formatError ?? formatErrorMessage;
  const orderBy = options.orderBy ?? "received";
  const startLimit = options.startLimit ?? DEFAULT_INGRESS_START_LIMIT;
  const deferredLaneOccupancy = options.deferredLaneOccupancy ?? "hold";
  const activeByClaim = new Map<string, ActiveHandlerState<TPayload, TMetadata>>();
  const laneOwnerByKey = new Map<string, ActiveHandlerState<TPayload, TMetadata>>();
  const laneKeyFor = (record: ChannelIngressQueueRecord<TPayload, TMetadata>) =>
    resolveLaneKey(record, options.deriveLaneKey, options.reconcileStoredLaneKey);
  let disposed = false;

  const log = (message: string) => options.onLog?.(message);
  const reportFailure = createIngressFailureReporter(options.onDeadLetter, log, formatError);

  const clearStallTimer = (state: ActiveHandlerState<TPayload, TMetadata>) => {
    clearTimeout(state.stallTimer);
    state.stallTimer = undefined;
  };

  const abortActiveClaims = () => {
    // Joining monitors retain claim custody through accepted settlement writes.
    // Standalone drains preserve abort-time recovery for uncooperative handlers.
    if (!retainOwnerUntilDispose || disposed) {
      deregisterLiveIngressDrainInstance(ownerId);
    }
    const reason = disposed
      ? new Error("ingress-drain-disposed")
      : toErrorObject(options.abortSignal?.reason, "ingress-drain-aborted");
    for (const state of activeByClaim.values()) {
      if (state.phase === "dispatching" || state.phase === "deferred") {
        // Retire stall detection without blocking a late terminal claim write.
        clearStallTimer(state);
        state.abortController.abort(reason);
      }
    }
  };
  if (options.abortSignal?.aborted) {
    abortActiveClaims();
  } else {
    options.abortSignal?.addEventListener("abort", abortActiveClaims, { once: true });
  }

  const removeActive = (state: ActiveHandlerState<TPayload, TMetadata>) => {
    clearStallTimer(state);
    clearIngressClaimRefresh(state);
    activeByClaim.delete(activeClaimKey(state.claim));
    options.onClaimSettled?.();
    if (laneOwnerByKey.get(state.laneKey) === state) {
      laneOwnerByKey.delete(state.laneKey);
    }
    state.occupiesLane = false;
  };

  const markLeaseReclaimed = (state: ActiveHandlerState<TPayload, TMetadata>) => {
    // Guillotine-style closed flag: late onAdopted throws IngressAdoptionLostError.
    // Do not release/fail — another owner holds the claim token.
    if (state.phase === "settled" || state.guillotined || state.superseded) {
      return;
    }
    state.guillotined = true;
    clearStallTimer(state);
    clearIngressClaimRefresh(state);
    state.abortController.abort(new Error("ingress claim lease reclaimed"));
  };

  const isStopped = () => disposed || options.abortSignal?.aborted === true;

  const retry = createIngressRetryPolicy(queue);
  const { completeClaimWithRetry, releaseClaim, failClaim } = createIngressWriter(options, {
    queue,
    now,
    formatError,
    log,
    isStopped,
    onTerminal: retry.clear,
  });

  const applyFailureDisposition = async (
    state: ActiveHandlerState<TPayload, TMetadata>,
    err: unknown,
  ) => {
    const { claim } = state;
    if (err instanceof GatewayDrainingError) {
      // Root dispatch closes before durable transport admission during restart.
      // Preserve the row for the successor without spending its failure budget.
      await releaseClaim(claim, { recordAttempt: false });
      return;
    }
    const disposition = retry.failure({
      err,
      event: claim,
      formatError,
      resolveNonRetryableFailure: (failure) =>
        resolveQueueCapDropFailure(failure, options.resolveNonRetryableFailure),
      config: options.retryPolicy,
      now: now(),
    });
    if (disposition.kind === "fail") {
      state.phase = "failed";
    }
    const committed =
      disposition.kind === "fail"
        ? await failClaim(claim, disposition.reason, disposition.message)
        : await releaseClaim(claim, { ...disposition, lastError: disposition.message });
    const displayId = claim.id.replace(/^0+(?=\d)/, "") || claim.id;
    if (!committed) {
      log(`spooled update ${displayId} settlement skipped: claim no longer owns the event`);
      return;
    }
    if (disposition.kind === "fail") {
      await reportFailure(claim, disposition);
      return;
    }
    log(`spooled update ${displayId} failed; keeping for retry: ${disposition.message}`);
  };

  const armStallWatchdog = (state: ActiveHandlerState<TPayload, TMetadata>) => {
    clearStallTimer(state);
    state.stallTimer = setTimeout(() => {
      // Pre-adoption only (dispatching OR deferred). Timer is not cleared by deferral.
      if (state.phase !== "dispatching" && state.phase !== "deferred") {
        return;
      }
      const ageMs = now() - state.startedAt;
      const displayId = state.eventId.replace(/^0+(?=\d)/, "") || state.eventId;
      const message = `Channel ingress claim→adoption stalled for event ${displayId} on lane ${state.laneKey} after ${ageMs}ms; applying retry policy (handler-timeout).`;
      const timeoutError = new Error(message);
      // Closed guillotine flag — catch must not string-sniff errors.
      state.guillotined = true;
      clearStallTimer(state);
      log(message);
      state.abortController.abort(timeoutError);
      // Route the timeout through the canonical retry owner. A release/fail write
      // error must not falsely settle (would stop heartbeat and wedge recovery).
      void state
        .settleOnce(() => applyFailureDisposition(state, timeoutError))
        .catch((err: unknown) => {
          log(
            `ingress drain: failed to settle stalled event ${displayId}; holding claim: ${formatError(err)}`,
          );
        });
    }, adoptionStallTimeoutMs);
    state.stallTimer.unref?.();
  };

  const releaseUnadopted = async (
    state: ActiveHandlerState<TPayload, TMetadata>,
    releaseOptions: { lastError?: string; recordAttempt?: boolean },
  ) => {
    if (!isPreAdoptionState(state)) {
      return;
    }
    clearStallTimer(state);
    await state
      .settleOnce(async () => {
        await releaseClaim(state.claim, releaseOptions);
      })
      .catch(() => undefined);
  };

  const createLifecycle = (
    state: ActiveHandlerState<TPayload, TMetadata>,
  ): ChannelIngressDispatchLifecycle => {
    const onFailed = (error: unknown) =>
      isPreAdoptionState(state)
        ? state.settleOnce(() => applyFailureDisposition(state, error))
        : undefined;
    return {
      abortSignal: state.abortController.signal,
      readLaneBacklog: async () => {
        const { pending, claims } = await readIngressUnsettled(queue, { orderBy });
        const waiting = [
          ...pending.filter((row) => retry.delay(row, options.retryPolicy, now()) <= 0),
          ...claims.filter((claim) => {
            const active = activeByClaim.get(activeClaimKey(claim));
            return (
              !active ||
              (isPreAdoptionState(active) && (active.phase !== "deferred" || active.occupiesLane))
            );
          }),
        ];
        return waiting
          .filter((row) => row.id !== state.claim.id && laneKeyFor(row) === state.laneKey)
          .toSorted(
            (left, right) =>
              (orderBy === "received" ? left.receivedAt - right.receivedAt : 0) ||
              Buffer.compare(Buffer.from(left.id), Buffer.from(right.id)),
          );
      },
      onAdopted: async () => {
        // Lost adoption is loud: guillotine/supersede already tombstoned/failed the claim.
        if (state.guillotined) {
          throw new IngressAdoptionLostError("guillotined");
        }
        if (state.superseded) {
          throw new IngressAdoptionLostError("superseded");
        }
        if (state.phase === "adopted" || state.phase === "failed" || state.phase === "settled") {
          // A terminal decision already owns this claim.
          return;
        }
        // Complete at adoption, not settle — frees the lane for later events.
        state.phase = "adopted";
        clearStallTimer(state);
        await state.settleOnce(() => completeClaimWithRetry(state.claim));
      },
      onDeferred: () => {
        if (state.phase !== "dispatching") {
          return;
        }
        // Deferred holds the claim; watchdog remains armed until adoption or abandon.
        state.phase = "deferred";
        if (deferredLaneOccupancy === "release") {
          if (laneOwnerByKey.get(state.laneKey) === state) {
            laneOwnerByKey.delete(state.laneKey);
          }
          state.occupiesLane = false;
        }
      },
      onDeferredHeartbeat: () => {
        // A cleared watchdog marks adoption finalization or retired ownership.
        if ((state.phase === "dispatching" || state.phase === "deferred") && state.stallTimer) {
          armStallWatchdog(state);
        }
      },
      deferredHeartbeatIntervalMs: Math.max(1, Math.floor(adoptionStallTimeoutMs / 3)),
      onAdoptionFinalizing: () => {
        if (!isPreAdoptionState(state)) {
          return;
        }
        // Adoption finalization (settlement hold) owns the claim; do not let a
        // stall watchdog race and dead-letter an about-to-complete event.
        clearStallTimer(state);
      },
      onFailed,
      onCancelled: async () => {
        // Cancellation means ownership ended before delivery, so preserve every
        // prior retry fact while reopening the canonical row for replacement.
        await releaseUnadopted(state, { recordAttempt: false });
      },
      onAbandoned: () => releaseUnadopted(state, { lastError: "turn-abandoned" }),
      onDropped: (reason) => onFailed(new IngressQueueCapDropError(reason)),
    };
  };

  const supersedeActiveIfNeeded = async (
    candidate: ChannelIngressQueueRecord<TPayload, TMetadata>,
    laneKey: string,
  ): Promise<boolean> =>
    await supersedeActiveStatesIfNeeded({
      candidate,
      laneKey,
      activeByClaim,
      laneOwnerByKey,
      shouldSupersedePending: options.shouldSupersedePending,
      clearStallTimer,
      completeClaim: completeClaimWithRetry,
      formatError,
      log,
    });

  const runClaimed = (
    claim: ChannelIngressQueueClaim<TPayload, TMetadata>,
    laneKey: string,
    ready?: Promise<void>,
    admittedLaneKey?: string,
  ): ActiveHandlerState<TPayload, TMetadata> => {
    const abortController = new AbortController();
    const state = {
      eventId: claim.id,
      laneKey,
      claim,
      abortController,
      startedAt: now(),
      phase: "dispatching" as const,
      occupiesLane: true,
      guillotined: false,
      superseded: false,
      task: Promise.resolve(),
      settleOnce: async () => {},
    } as ActiveHandlerState<TPayload, TMetadata>;
    state.settleOnce = createIngressSettleOwner(state, removeActive);
    // Register ownership before dispatch starts. runOutsideAsyncWorkScope runs
    // the task body synchronously up to its first await, so a handler that calls
    // onDeferred() before awaiting would otherwise release a lane this state does
    // not own yet, only for the post-dispatch registration to re-own it.
    activeByClaim.set(activeClaimKey(claim), state);
    laneOwnerByKey.set(laneKey, state);
    const lifecycle = createLifecycle(state);
    if (!ready) {
      armStallWatchdog(state);
    }
    armIngressClaimRefresh(state, {
      queue,
      claimLeaseMs,
      now,
      onReclaimed: markLeaseReclaimed,
      log,
      formatError,
    });

    // drainOnce starts dispatches without awaiting them, so this task outlives
    // the admission context it inherits (a detached pump root or the transport
    // request that enqueued the event). Retain a live root until the task
    // settles; when the inherited root is already released, dispatch outside it
    // so the dead lease cannot make session admission refuse the turn as
    // draining. A real restart drain still refuses both paths at admission.
    // Dispatches and queued followups outlive the pump's async work scope.
    // Leave that scope so its closure cannot reject their later tracked work.
    const releaseRootWork = retainGatewayRootWorkAdmissionContinuation();
    state.task = runOutsideAsyncWorkScope(async () => {
      try {
        if (ready) {
          // A transport ACK can await I/O. Own and refresh the claim now, but
          // start the dispatch watchdog only when that callback has settled.
          await ready;
          state.startedAt = now();
          armStallWatchdog(state);
        }
        const result = await (releaseRootWork
          ? options.dispatchClaimedEvent(claim, lifecycle, admittedLaneKey)
          : runOutsideGatewayRootWorkAdmission(() =>
              options.dispatchClaimedEvent(claim, lifecycle, admittedLaneKey),
            ));
        if (result?.kind === "transferred") {
          // The downstream owner atomically tombstoned this exact claim. Do not
          // complete it again or turn a shutdown race into a replayable failure.
          clearStallTimer(state);
          retry.clear(claim.id);
          await state.settleOnce(async () => {});
          return;
        }
        if (result?.kind === "pending") {
          clearStallTimer(state);
          await state.settleOnce(async () => {
            await releaseClaim(claim, { recordAttempt: false });
          });
          return;
        }
        // dispose() leaves claims for recovery. Session abort mid-flight
        // (skipped/void) also leaves the claim; a terminal completed/failed
        // result still settles even if abort raced the return.
        if (disposed) {
          return;
        }
        if (
          options.abortSignal?.aborted &&
          result?.kind !== "completed" &&
          result?.kind !== "failed-retryable"
        ) {
          return;
        }
        if (state.phase === "settled" || state.phase === "adopted" || state.phase === "failed") {
          return;
        }
        if (state.guillotined || state.superseded) {
          return;
        }
        if (result?.kind === "deferred") {
          lifecycle.onDeferred();
          return;
        }
        if (result?.kind === "failed-retryable") {
          clearStallTimer(state);
          await state.settleOnce(() => applyFailureDisposition(state, result.error));
          return;
        }
        // Default: dispatch returned without deferral — complete when channel
        // did not call onAdopted (channels should prefer lifecycle.onAdopted).
        // Mark adopted BEFORE tombstone retries so a write failure cannot release
        // a claim whose dispatch side effects already ran (replay risk).
        if (state.phase === "dispatching") {
          await lifecycle.onAdopted();
        }
      } catch (err) {
        if (isStopped() || state.phase === "settled") {
          return;
        }
        // Guillotine / supersede own settleOnce — do not fail/release again.
        if (state.guillotined || state.superseded) {
          return;
        }
        // A terminal write may have failed; never convert it to a retryable delivery.
        if (state.phase === "adopted" || state.phase === "failed") {
          log(
            `ingress drain: terminal settlement error for event ${claim.id} while claim held: ${formatError(err)}`,
          );
          return;
        }
        clearStallTimer(state);
        await state.settleOnce(() => applyFailureDisposition(state, err));
      } finally {
        releaseRootWork?.();
      }
    });

    return state;
  };

  const recoverStaleClaims = async (): Promise<number> => {
    const activeLanes = new Set(laneOwnerByKey.keys());
    return await queue.recoverStaleClaims({
      staleMs: 0,
      now: now(),
      shouldRecover: (claim) => {
        if (activeByClaim.has(activeClaimKey(claim))) {
          return false;
        }
        // Same-PID multi-drain: only recover when the owner instance is not live.
        if (isLiveLocalIngressClaim(claim)) {
          return false;
        }
        return !isIngressClaimOwnedByOtherLiveProcess(claim, {
          maxAgeMs: claimLeaseMs,
          now: now(),
        });
      },
      shouldRecoverCorrupt: (claim) => {
        if (claim.laneKey && activeLanes.has(claim.laneKey)) {
          return false;
        }
        if (isLiveLocalIngressClaim(claim)) {
          return false;
        }
        return !isIngressCorruptClaimOwnedByOtherLiveProcess(claim, {
          maxAgeMs: claimLeaseMs,
          now: now(),
        });
      },
    });
  };

  const drainOnce = async (drainOptions?: {
    shouldStop?: () => boolean;
    recoverStaleClaims?: boolean;
  }): Promise<{ started: number }> => {
    if (disposed) {
      return { started: 0 };
    }
    const shouldStop = () =>
      disposed || drainOptions?.shouldStop?.() === true || options.abortSignal?.aborted === true;

    if (drainOptions?.recoverStaleClaims !== false) {
      await recoverStaleClaims();
    }

    // Derived lanes, supersede and priority select from the whole snapshot.
    const paged =
      orderBy === "received" &&
      queue.listUnsettled !== undefined &&
      !options.deriveLaneKey &&
      !options.shouldSupersedePending &&
      !prioritizePending;
    const blockedLaneKeys = new Set<string>(laneOwnerByKey.keys());
    const pendingLaneKeys = new Set<string>();
    const currentTime = now();
    let retryAt: number | undefined;
    let started = 0;
    const pages = readIngressBacklogPages(queue, { orderBy, paged, blockedLaneKeys });
    for await (const { pending, claims, lastPage } of pages) {
      for (const claim of claims) {
        const state = activeByClaim.get(activeClaimKey(claim));
        // A failed deferral still owns the lane until its release/backoff commits.
        if (
          !(
            state?.phase === "deferred" &&
            !state.occupiesLane &&
            !state.settlement &&
            !state.settlementFailure &&
            !state.guillotined &&
            !state.superseded
          )
        ) {
          blockedLaneKeys.add(laneKeyFor(claim));
        }
      }
      const retryDelayed = new Uint8Array(pending.length);
      // The ordered snapshot owns selection for this pass. A delayed head blocks its lane.
      for (const [index, event] of pending.entries()) {
        const laneKey = laneKeyFor(event);
        if (retry.delay(event, options.retryPolicy, now()) > 0) {
          retryDelayed[index] = 1;
          if (!pendingLaneKeys.has(laneKey)) {
            blockedLaneKeys.add(laneKey);
            const delay = retry.delay(event, options.retryPolicy, currentTime);
            retryAt = Math.min(retryAt ?? Infinity, currentTime + delay);
          }
        }
        pendingLaneKeys.add(laneKey);
      }
      // Only a pass that saw every delayed head may replace the retry timer. A pass stops
      // early for started or active work, and its settlement requests the next pass.
      if (lastPage) {
        options.onRetryAt?.(retryAt);
      }

      // Optional supersede scan: pending events may abort unadopted same-lane work.
      // Free the lane so this pass can take the superseding event.
      for (const event of pending) {
        if (shouldStop()) {
          break;
        }
        const laneKey = laneKeyFor(event);
        if (await supersedeActiveIfNeeded(event, laneKey)) {
          blockedLaneKeys.delete(laneKey);
        }
      }

      const candidates = prioritizePending
        ? pending
            .map((event, index) => [index, event, Number(prioritizePending(event))] as const)
            .toSorted((left, right) => right[2] - left[2])
        : pending.entries();
      for (const [index, event] of candidates) {
        if (shouldStop() || started >= startLimit) {
          break;
        }
        const selectedLaneKey = laneKeyFor(event);
        if (retryDelayed[index] === 1 || blockedLaneKeys.has(selectedLaneKey)) {
          continue;
        }
        // The drain already selected this ordered lane head. The pending-only
        // update arbitrates competing claimants without rereading the backlog.
        // Scheduling lanes may be per-event; only reconciliation may replace
        // an existing transport identity checked by the monitor before delivery.
        const claimLaneKey =
          event.laneKey === undefined
            ? options.deriveLaneKey?.(event)
            : options.reconcileStoredLaneKey
              ? selectedLaneKey
              : event.laneKey;
        const claimed = await queue.claim(event.id, {
          ownerId,
          laneKey: claimLaneKey,
        });
        if (!claimed) {
          // A competing owner may still hold the head; its tail waits for the next pass.
          blockedLaneKeys.add(selectedLaneKey);
          continue;
        }
        if (shouldStop()) {
          await queue.release(claimed, { recordAttempt: false });
          break;
        }
        const laneKey = laneKeyFor(claimed);
        const existing = laneOwnerByKey.get(laneKey);
        if (existing && existing.phase !== "settled") {
          if (await supersedeActiveIfNeeded(claimed, laneKey)) {
            blockedLaneKeys.delete(laneKey);
          }
          if (laneOwnerByKey.has(laneKey)) {
            await queue.release(claimed, { recordAttempt: false });
            blockedLaneKeys.add(laneKey);
            continue;
          }
        }
        runClaimed(claimed, laneKey);
        blockedLaneKeys.add(laneKey);
        started += 1;
      }
      if (shouldStop() || started >= startLimit) {
        break;
      }
    }
    return { started };
  };

  function dispose(): void;
  function dispose(disposeOptions: { waitForSettlements: true }): Promise<void>;
  function dispose(disposeOptions?: { waitForSettlements: true }): void | Promise<void> {
    if (disposeOptions?.waitForSettlements) {
      if (!retainOwnerUntilDispose || !options.abortSignal?.aborted) {
        return Promise.reject(
          new Error("Joined ingress disposal requires an already-aborted retained owner"),
        );
      }
      return (async () => {
        for (;;) {
          const states = [...activeByClaim.values()];
          const settlements = states.flatMap((state) =>
            state.settlement ? [state.settlement] : [],
          );
          if (settlements.length === 0) {
            const failure = states.find((state) => state.settlementFailure)?.settlementFailure;
            // Retire the drain while preserving only its unresolved terminal claims.
            dispose();
            if (failure) {
              throw failure.error;
            }
            return;
          }
          await Promise.allSettled(settlements);
        }
      })();
    }
    disposed = true;
    for (const state of activeByClaim.values()) {
      if (
        state.phase === "adopted" ||
        state.phase === "failed" ||
        state.superseded ||
        hasSqliteWorkerOutcomeUnknown(state.settlementFailure?.error)
      ) {
        retainRetiredIngressClaim(state.claim);
      }
    }
    options.abortSignal?.removeEventListener("abort", abortActiveClaims);
    abortActiveClaims();
    // Snapshot: removeActive mutates activeByClaim during this sweep.
    const activeStates = Array.from(activeByClaim.values());
    for (const state of activeStates) {
      removeActive(state);
    }
  }

  return {
    idleOwnerId: () => (!disposed && activeByClaim.size === 0 ? ownerId : undefined),
    dispatchClaimed: (
      claim: ChannelIngressQueueClaim<TPayload, TMetadata>,
      ready: Promise<void>,
      admittedLaneKey?: string,
    ) => {
      runClaimed(claim, admittedLaneKey ?? laneKeyFor(claim), ready, admittedLaneKey);
    },
    recoverStaleClaims,
    drainOnce,
    activeLaneKeys: () => new Set(laneOwnerByKey.keys()),
    waitForIdle: async () => {
      const tasks = [...activeByClaim.values()].map((state) => state.task);
      await Promise.allSettled(tasks);
    },
    dispose,
  };
}
