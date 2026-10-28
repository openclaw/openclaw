/** Exact input identity and custody; scheduling remains with the mailbox selector. */
import type { FollowupRun, QueueSettings } from "../auto-reply/reply/queue/types.js";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { formatErrorMessage } from "../infra/errors.js";
import { notifyGatewayWorkMetricsChanged } from "../infra/gateway-work-metrics-events.js";
import { defaultRuntime } from "../runtime.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  type SessionControllerInput,
  type SessionControllerSourceCustody,
  type SessionControllerSourceInjection,
  type SessionControllerWithdrawalHold,
  inputCancellation,
} from "./session-controller.contracts.js";
import { logSessionControllerPhase } from "./session-controller.diagnostics.js";
import {
  isCurrentSessionControllerOperation,
  isReplyOperationAbortable,
  sessionControllers,
} from "./session-controller.state.js";

export function bindSessionControllerSource(
  input: SessionControllerInput,
  source: FollowupRun,
): void {
  if (
    input.phase === "consumed" ||
    input.retirementRequested ||
    input.injection ||
    (input.source && input.source !== source)
  ) {
    throw new Error("Source binding no longer current");
  }
  input.sourceAdapter?.authority?.assertCurrent();
  input.sourceAdapter?.signal?.throwIfAborted();
  input.source = source;
  source.controllerInput = input;
}

export function isSessionControllerSourceQueued(input: SessionControllerInput): boolean {
  return input.phase === "preparing" || input.phase === "waiting" || input.phase === "injecting";
}

/**
 * Releases successors only after this reservation can no longer inject ahead of them:
 * its native acceptance, its settled outcome, a turn claim, or its retirement.
 */
export function settleSessionControllerSourceInjectionOrder(
  input: SessionControllerInput,
  consumed: boolean,
): void {
  input.injectionAttempted = true;
  input.injectionOrder.settle(consumed);
}

/** Retains an early source through the exact native outcome, not just its ACK. */
export function beginSessionControllerSourceInjection(
  input: SessionControllerInput,
  options: { keepOrderOnDecline?: boolean } = {},
): SessionControllerSourceInjection {
  if (
    (input.phase !== "preparing" && input.phase !== "waiting") ||
    input.injectionAttempted ||
    input.injection ||
    input.claim ||
    input.withdrawalHolds ||
    input.retirementRequested ||
    input.custody.cancellationRetired ||
    input.abortSignal.aborted
  ) {
    return { admit: async () => false, accepted() {}, withdraw() {}, finish() {} };
  }
  const phase = input.phase;
  const olderReservations = input.mailbox.entries
    .filter(
      (entry) =>
        entry.sequence < input.sequence && entry.phase !== "consumed" && entry.claim === undefined,
    )
    .map((entry) => entry.injectionOrder.settled);
  const predecessor =
    input.policy.mode === "interrupt" || olderReservations.length === 0
      ? Promise.resolve(true)
      : Promise.all(olderReservations).then(() => true);
  const outcome = createDeferredCore<boolean>();
  const pending: NonNullable<SessionControllerInput["injection"]> = {
    predecessor,
    settled: predecessor.then(() => outcome.promise),
    settle: outcome.resolve,
  };
  // Install custody before any await. Neither withdrawal nor a turn claim may
  // take this source until the captured native attempt proves its outcome.
  input.injectionAttempted = true;
  input.injection = pending;
  input.phase = "injecting";
  const diagnosticIdentity = {
    sessionKey: input.mailbox.key,
    sourceId: input.protocolRunId ?? input.instance.id,
  };
  logSessionControllerPhase({
    ...diagnosticIdentity,
    phase: "injection-predecessor",
    status: "waiting",
    pendingInputs: olderReservations.length,
  });
  let started = false;
  let finished = false;
  const finish = (consumed: boolean) => {
    if (finished || input.injection !== pending) {
      return;
    }
    finished = true;
    const mustConsume = consumed || pending.accepted === true;
    logSessionControllerPhase({
      ...diagnosticIdentity,
      phase: "injection-outcome",
      status: "settled",
      reason: mustConsume ? "consumed" : "declined",
    });
    input.injection = undefined;
    input.phase = phase;
    pending.settle(mustConsume);
    if (
      mustConsume ||
      !options.keepOrderOnDecline ||
      input.retirementRequested ||
      input.abortSignal.aborted
    ) {
      settleSessionControllerSourceInjectionOrder(input, mustConsume);
    } else {
      input.injectionAttempted = undefined;
    }
    if (mustConsume || input.retirementRequested || input.abortSignal.aborted) {
      retireSessionControllerInput(input);
    } else {
      input.mailbox.wake();
    }
  };
  return {
    async admit() {
      if (started || finished) {
        return false;
      }
      try {
        await racePromiseWithAbortSignal(predecessor, input.abortSignal);
        logSessionControllerPhase({
          ...diagnosticIdentity,
          phase: "injection-predecessor",
          status: "settled",
        });
        if (
          started ||
          finished ||
          input.injection !== pending ||
          input.phase !== "injecting" ||
          input.withdrawalHolds ||
          input.claim ||
          input.retirementRequested ||
          input.custody.cancellationRetired ||
          input.mailbox.owner.mailbox !== input.mailbox ||
          sessionControllers.get(input.mailbox.owner.id) !== input.mailbox.owner
        ) {
          if (!started) {
            finish(false);
          }
          return false;
        }
        input.sourceAdapter?.authority?.assertCurrent();
        input.abortSignal.throwIfAborted();
        started = true;
        pending.admitted = true;
        logSessionControllerPhase({
          ...diagnosticIdentity,
          phase: "injection-outcome",
          status: "waiting",
        });
        return true;
      } catch (error) {
        // A failed live-authority assertion cannot return a queued-ready source
        // to selection. Retire before releasing the injection receipt: finish
        // can synchronously wake the mailbox and enter a backend.
        retireSessionControllerInput(input);
        finish(false);
        if (input.abortSignal.aborted) {
          return false;
        }
        throw error;
      }
    },
    accepted(accepted) {
      if (!started || finished || input.injection !== pending) {
        return;
      }
      // A later rejection cannot undo observed ownership. False alone does not
      // prove safe replay: an indeterminate final outcome still consumes input.
      pending.accepted = pending.accepted === true || accepted;
      if (accepted) {
        // The native owner now holds this input ahead of any later steer and it can
        // never be replayed, so successors need not wait for its transcript commit.
        // Native commits can depend on later input, e.g. an answer to a pending question.
        settleSessionControllerSourceInjectionOrder(input, true);
      }
    },
    withdraw() {
      if (finished || input.injection !== pending) {
        return;
      }
      // Unlike a bare rejection, the runtime proved removal before delivery, so
      // the input was never used and may run as its own turn. Released order is
      // not re-held: a steer admitted meanwhile may still land first.
      pending.accepted = false;
    },
    finish,
  };
}

export function retireSessionControllerSourceCancellation(input: SessionControllerInput): void {
  input.custody.cancellationRetired = true;
  notifyGatewayWorkMetricsChanged();
}

/** Resolve inline/reset policy on the original input before publishing runnable work. */
export function updateSessionControllerSourcePolicy(
  input: SessionControllerInput,
  policy: QueueSettings,
): void {
  const assertConfigurable = () => {
    if (
      input.phase === "consumed" ||
      input.retirementRequested ||
      input.injection ||
      input.withdrawalHolds
    ) {
      throw new Error("Source policy is no longer configurable");
    }
    input.abortSignal.throwIfAborted();
  };
  assertConfigurable();
  input.sourceAdapter?.authority?.assertCurrent();
  assertConfigurable();
  const wasInterrupt = input.policy.mode === "interrupt";
  input.policy = Object.freeze({ ...policy });
  if (policy.mode === "interrupt" && !wasInterrupt && !input.claim) {
    input.mailbox.priority = input;
  } else if (policy.mode !== "interrupt" && input.mailbox.priority === input) {
    input.mailbox.priority = undefined;
  }
}

/** Retain already-started source work independently of cancellation or turn selection. */
export function trackSessionControllerSourceWork(
  input: SessionControllerInput,
  work: Promise<unknown>,
): void {
  const pending = (input.custody.work ??= new Set());
  if (pending.has(work)) {
    return;
  }
  pending.add(work);
  const settled = () => {
    pending.delete(work);
    if (!pending.size) {
      input.custody.work = undefined;
      if (input.retirementRequested) {
        retireSessionControllerInput(input);
      }
    }
  };
  void work.then(settled, (error: unknown) => {
    input.custody.failure ??= error;
    settled();
  });
}

/** Cancellation is not settlement of a native write, source adoption, or selected turn. */
export function retireSessionControllerInput(input: SessionControllerInput): void {
  if (input.phase === "consumed") {
    return;
  }
  input.retirementRequested = true;
  if (
    input.cancelling ||
    input.withdrawalHolds ||
    (input.claim && !input.claim.released) ||
    (input.injection && input.phase === "injecting")
  ) {
    return;
  }
  // An unstarted producer must leave its claim wait before its cleanup can settle.
  const reject = input.reject;
  input.reject = undefined;
  reject?.(
    input.abortSignal.aborted
      ? input.abortSignal.reason
      : new Error("Input cancelled before turn claim"),
  );
  if (input.custody.work?.size) {
    return;
  }
  if (input.source && !input.custody.completed) {
    completeSessionControllerSourceLifecycle(
      input.source,
      input.source.controllerClaim?.custody ?? input.custody,
    );
  }
  const custodyPending = input.custody.settling ?? input.custody.adopting;
  if (custodyPending) {
    if (!input.retirementPending) {
      input.retirementPending = true;
      const finish = () => {
        input.retirementPending = false;
        retireSessionControllerInput(input);
      };
      void custodyPending.then(finish, finish);
    }
    return;
  }
  const injection = input.injection;
  input.injection = undefined;
  settleSessionControllerSourceInjectionOrder(input, false);
  input.phase = "consumed";
  input.payload = "unbound";
  if (input.mailbox.priority === input) {
    input.mailbox.priority = undefined;
  }
  // Only an injection not yet started can truthfully be rejected by cancellation.
  injection?.settle(false);
  const dispose = input.custody.disposeSource;
  input.custody.disposeSource = undefined;
  const finish = (error?: unknown) => {
    const index = input.mailbox.entries.indexOf(input);
    if (index >= 0) {
      input.mailbox.entries.splice(index, 1);
      notifyGatewayWorkMetricsChanged();
    }
    if (error !== undefined) {
      input.custody.failure = error;
      input.settlement.reject(error);
      defaultRuntime.error?.("mailbox source settlement failed: " + formatErrorMessage(error));
    } else if (input.custody.failure !== undefined) {
      input.settlement.reject(input.custody.failure);
    } else {
      input.settlement.resolve();
    }
    input.mailbox.wake();
  };
  // The receipt remains rejecting for callers; this observer prevents unhandled rejection
  // when a source has no stop/reset waiter.
  void input.settlement.promise.catch(() => {});
  try {
    dispose?.();
    const settled = input.sourceAdapter?.onSettled?.();
    if (settled) {
      void Promise.resolve(settled).then(() => finish(), finish);
    } else {
      finish();
    }
  } catch (error) {
    finish(error);
  }
}

/** Requests cancellation of one exact source; actual write/adoption settlement stays owned. */
export function abortSessionControllerInput(
  input: SessionControllerInput,
  reason?: unknown,
  assertCurrent: () => void = () => {},
): boolean {
  assertCurrent();
  if (
    input.phase === "consumed" ||
    input.custody.cancellationRetired ||
    input.withdrawalHolds ||
    input.cancelling ||
    input[inputCancellation].signal.aborted
  ) {
    return false;
  }
  const operation = input.claim?.operation;
  if (
    operation &&
    !operation.abortSignal.aborted &&
    (!isCurrentSessionControllerOperation(operation) || !isReplyOperationAbortable(operation))
  ) {
    return false;
  }
  // The requester authorizes new cancellation effects. The original execution
  // authority may already be revoked; it cannot veto its own cleanup.
  assertCurrent();
  const wasRetiring = input.retirementRequested;
  input.retirementRequested = true;
  input.cancelling = true;
  let committed = !operation || operation.abortSignal.aborted;
  try {
    try {
      // The operation owner stamps the causal result BEFORE abort listeners run.
      // Its upstream listener observes that result and never cancels a second time.
      if (operation && !committed) {
        committed = operation.abort(reason);
      }
    } finally {
      // Backend cancellation may throw after committing the operation's abort.
      // That still requires exact source cleanup; it is not a retryable refusal.
      committed ||= operation?.abortSignal.aborted === true;
      if (committed) {
        const cause = reason ?? operation?.abortSignal.reason;
        input[inputCancellation].abort(cause);
        input.claim?.abortController.abort(cause);
        input.sourceAdapter?.cancel?.(cause);
        if (
          input.source &&
          !input.claim &&
          !input.injection &&
          !input.custody.adopted &&
          !input.custody.completed
        ) {
          void notifySessionControllerSourceAbandonment(input.source, input.custody);
        }
      }
    }
  } finally {
    input.cancelling = false;
    if (committed) {
      notifyGatewayWorkMetricsChanged();
      retireSessionControllerInput(input);
    } else {
      input.retirementRequested = wasRetiring;
    }
  }
  return committed;
}

/** Queued Stop joins notification and publication; raw preparation retains its own fence. */
export async function captureSessionControllerSourceStopAcknowledgment(
  input: SessionControllerInput,
): Promise<void> {
  const adapter = input.sourceAdapter;
  const publication = adapter?.cancellationAcknowledgment?.bind(adapter);
  // Raw preparation, injection, and claimed work retain their own settlement fence.
  const notification =
    input.custody.work?.size || input.injection || (input.claim && !input.claim.released)
      ? (input.custody.settling ?? input.custody.abandonment?.completion)
      : input.settlement.promise;
  const failures: unknown[] = [];
  try {
    await notification;
  } catch (error) {
    failures.push(error);
  }
  // Async abandonment may register the terminal write required by this ACK.
  try {
    await publication?.();
  } catch (error) {
    if (!failures.includes(error)) {
      failures.push(error);
    }
  }
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, "Session cancellation acknowledgment failed");
  }
}

export function captureSessionControllerSourceSettlement(
  input: SessionControllerInput,
): Promise<void> {
  return input.settlement.promise;
}

export function holdSessionControllerSourceWithdrawal(
  input: SessionControllerInput,
): SessionControllerWithdrawalHold {
  if (
    !isSessionControllerSourceQueued(input) ||
    input.phase === "injecting" ||
    input.injection ||
    input.claim ||
    input.withdrawalHolds ||
    input.custody.cancellationRetired ||
    input.retirementRequested
  ) {
    throw new Error("Source is unavailable for withdrawal");
  }
  input.withdrawalHolds++;
  let released = false;
  const release = () => {
    if (released || input.cancelling) {
      return;
    }
    released = true;
    input.withdrawalHolds--;
    if (input.retirementRequested || input.abortSignal.aborted) {
      retireSessionControllerInput(input);
    }
    input.mailbox.wake();
  };
  const commit = (reason?: unknown): boolean => {
    if (released || input.cancelling) {
      return false;
    }
    // The successful durable discard commits this captured capability. Source
    // or requester revocation during publication cannot veto its cleanup, and
    // an index replacement cannot redirect it to a same-ID successor.
    input.retirementRequested = true;
    input.cancelling = true;
    try {
      input[inputCancellation].abort(reason);
      input.sourceAdapter?.cancel?.(reason);
    } finally {
      input.cancelling = false;
      release();
    }
    return true;
  };
  return Object.assign(release, {
    release,
    commit,
    cancel(assertCurrent: () => void, reason?: unknown): boolean {
      assertCurrent();
      if (
        released ||
        input.withdrawalHolds !== 1 ||
        !isSessionControllerSourceQueued(input) ||
        input.phase === "injecting" ||
        input.claim ||
        input.custody.cancellationRetired ||
        input.retirementRequested
      ) {
        return false;
      }
      return commit(reason);
    },
  });
}

/** The same notification is reused when the cancelled source later finishes draining. */
function notifySessionControllerSourceAbandonment(
  run: Pick<FollowupRun, "turnAdoptionLifecycle">,
  state: SessionControllerSourceCustody,
): void | Promise<void> {
  const prior = state.abandonment;
  if (prior) {
    if (prior.failure) {
      throw prior.failure.error;
    }
    return prior.completion;
  }
  const notification: NonNullable<SessionControllerSourceCustody["abandonment"]> = {};
  state.abandonment = notification;
  try {
    const completion = run.turnAdoptionLifecycle?.onAbandoned?.();
    if (completion) {
      notification.completion = Promise.resolve(completion);
      void notification.completion.catch(() => {});
      return notification.completion;
    }
  } catch (error) {
    notification.failure = { error };
    throw error;
  }
}

/** Completes one captured source's callbacks; never reacquires a mailbox. */
export function completeSessionControllerSourceLifecycle(
  run: Pick<FollowupRun, "turnAdoptionLifecycle" | "controllerInput" | "controllerClaim">,
  state: SessionControllerSourceCustody,
  disposition?: "consumed",
): void {
  if (state.completed) {
    return;
  }
  state.completed = true;
  state.stopHeartbeat?.();
  // Void callbacks run before the next cancellation effect; actual promises
  // retain custody until they settle. Do not insert a synthetic await between
  // two synchronous callbacks that can revoke the next effect's authority.
  const finish = (): void | Promise<void> => {
    const settle = () => run.turnAdoptionLifecycle?.onSettled?.();
    const afterFailure = (error: unknown): void | Promise<void> => {
      const pending = settle();
      if (pending) {
        return Promise.resolve(pending).then(() => {
          throw error;
        });
      }
      throw error;
    };
    let abandonment: void | Promise<void>;
    try {
      abandonment =
        disposition !== "consumed" && !state.adopted
          ? notifySessionControllerSourceAbandonment(run, state)
          : undefined;
    } catch (error) {
      return afterFailure(error);
    }
    return abandonment ? Promise.resolve(abandonment).then(settle, afterFailure) : settle();
  };
  let synchronous = true;
  const settled = (failure?: { error: unknown }) => {
    if (failure) {
      state.failure = failure.error;
    }
    try {
      state.releaseAuthority?.();
    } catch (error) {
      state.failure = error;
    }
    state.releaseAuthority = undefined;
    state.settling = undefined;
    const input = run.controllerInput;
    if (!run.controllerClaim && input && (!synchronous || !input.retirementRequested)) {
      retireSessionControllerInput(input);
    }
  };
  try {
    const completion = state.adopting
      ? state.adopting
          .catch((error: unknown) => {
            state.failure = error;
          })
          .then(finish)
      : finish();
    if (completion) {
      state.settling = Promise.resolve(completion);
      void state.settling.then(
        () => settled(),
        (error: unknown) => settled({ error }),
      );
    } else {
      settled();
    }
  } catch (error) {
    settled({ error });
  }
  synchronous = false;
}
