import { createDeferredCore } from "../shared/deferred.js";
import { isCurrentSessionControllerTurnInput } from "./session-controller.context.js";
import {
  REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS,
  type ReplyOperation,
  type CapturedSessionControllerEffect,
  type SessionControllerInput,
  type SessionStopChildrenResult,
  type SessionMutationKind,
} from "./session-controller.contracts.js";
import {
  runAfterRetiringSessionSources,
  waitUnlessAborted,
} from "./session-controller.lifecycle-observation.js";
import { inputMatchesSessionId } from "./session-controller.lifecycle-projections.js";
import {
  isReplyOperationAbortable,
  type SessionControllerEntry,
} from "./session-controller.state.js";
import type { SessionTarget } from "./session-controller.target.js";

export type SessionMutationPreemptOptions = Readonly<{
  activeRun: "abort" | "abort-if-abortable";
  waitingInputs: "cancel" | "keep";
  reason?: Error;
  shouldPreempt?: () => boolean;
  settleTimeoutMs?: number | null;
  stopChildren?: (applyParentStop: () => Promise<boolean>) => Promise<SessionStopChildrenResult>;
}>;

export type SessionMutationPolicy =
  | {
      kind: SessionMutationKind;
      policy: "preempt";
      preempt: SessionMutationPreemptOptions;
    }
  | {
      kind?: SessionMutationKind;
      policy?: "allow-live" | "wait";
      preempt?: never;
    };

export type SessionMutationPreemption = {
  settlement: Promise<void>;
  timeoutMs: number | null;
  sessionKey: string;
  kind: SessionMutationKind;
  reason: Error;
};

/** Reports that a mutation's captured preemption work did not settle within its bound. */
export class SessionMutationPreemptTimeoutError extends Error {
  constructor(
    readonly sessionKey: string,
    readonly mutationKind: SessionMutationKind,
  ) {
    super(`Session ${sessionKey} did not settle before ${mutationKind} preemption timed out`);
    this.name = "SessionMutationPreemptTimeoutError";
  }
}

function didMutationCancellationCommit(
  target: SessionControllerInput | ReplyOperation | CapturedSessionControllerEffect,
): boolean {
  if ("effect" in target) {
    return target.effect.interrupted !== undefined && target.effect.cancel.signal.aborted;
  }
  return "mailbox" in target
    ? target.retirementRequested === true && target.abortSignal.aborted
    : target.result?.kind === "aborted" && target.abortSignal.aborted;
}

/** Applies the selected wait or preempt policy to captured mutation competitors. */
export async function prepareSessionMutationCompetition(params: {
  policy: SessionMutationPolicy;
  claims: readonly import("./session-controller.mailbox.js").SessionControllerMailboxClaim[];
  entries: readonly SessionControllerEntry[];
  competitors: readonly ReplyOperation[];
  requiredSessionId?: string;
  targets: readonly SessionTarget[];
  signal?: AbortSignal;
  assertCurrent?: () => void;
}): Promise<{ waitForCompetitors: boolean; preemption?: SessionMutationPreemption }> {
  const { policy } = params;
  const assertCurrent = () => {
    params.signal?.throwIfAborted();
    params.assertCurrent?.();
  };
  if (policy.policy === "preempt") {
    assertCurrent();
    // Stop reaches the mailbox and reply queue; storage modules import the lifecycle,
    // so a static edge here would close an import cycle back into the session accessor.
    const { captureSessionControllerStop, stopSession } =
      await import("./session-controller.stop.js");
    assertCurrent();
    const options = policy.preempt;
    if (options.shouldPreempt?.() === false) {
      return { waitForCompetitors: false };
    }
    const claims = params.claims.filter(
      (claim) => options.activeRun === "abort" || claim.operation !== undefined,
    );
    const capture = captureSessionControllerStop({
      inputs: [
        ...claims.flatMap((claim) => claim.inputs),
        ...(options.waitingInputs === "cancel"
          ? params.entries.flatMap(
              (entry) =>
                entry.mailbox?.entries.filter(
                  (input) =>
                    !input.claim &&
                    inputMatchesSessionId(input, params.requiredSessionId) &&
                    !isCurrentSessionControllerTurnInput(input),
                ) ?? [],
            )
          : []),
      ],
      operations: params.competitors,
    });
    const cancelActive = (operation: ReplyOperation | undefined, cancel: () => boolean) =>
      options.activeRun === "abort" ||
      (operation !== undefined && isReplyOperationAbortable(operation))
        ? cancel()
        : false;
    const stopChildren = options.stopChildren;
    const stop = stopSession({
      source: "mutation",
      assertCurrent,
      mutation: {
        cancelQueued: options.waitingInputs === "cancel",
        stopChildren: stopChildren !== undefined,
      },
      capture,
      reason: options.reason,
      cancelInput: (input, cancel) =>
        input.claim ? cancelActive(input.claim.operation, cancel) : cancel(),
      cancelOperation: (operation, cancel) => cancelActive(operation, cancel),
      // Backend observers can throw after the exact owner committed its abort.
      // Settlement, not that observer failure, decides whether mutation may proceed.
      onError: (target) => (didMutationCancellationCommit(target) ? "continue" : undefined),
      stopChildren: stopChildren
        ? async (applyParentStop) =>
            await stopChildren(async () => {
              await applyParentStop();
              return true;
            })
        : undefined,
    });
    const settlement = stop.completed.then((outcome) => outcome.settled);
    // The caller may cancel while interrupting effects, before it joins Stop.
    // Keep that deferred rejection observed without changing its eventual result.
    void settlement.catch(() => {});
    return {
      waitForCompetitors: true,
      preemption: {
        settlement,
        timeoutMs:
          options.settleTimeoutMs === undefined
            ? REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS
            : options.settleTimeoutMs,
        sessionKey: params.targets[0]?.sessionKey ?? params.entries[0]?.key ?? "unknown",
        kind: policy.kind,
        reason: options.reason ?? new Error("Session mutation interrupted preparation"),
      },
    };
  }
  if (policy.policy === "wait") {
    await waitUnlessAborted(
      Promise.all([
        ...params.competitors.map((operation) => operation.ownerSettlement),
        ...params.claims.map((claim) => claim.settlement.promise),
      ]),
      params.signal,
    );
    return { waitForCompetitors: true };
  }
  return { waitForCompetitors: false };
}

/** Bounds Stop and effect settlement, leaving the mutation body outside the deadline. */
export async function runPreemptedSessionMutation<T>(params: {
  preemption: SessionMutationPreemption;
  effectsSettled: Promise<unknown>;
  signal?: AbortSignal;
  targets: readonly SessionTarget[];
  requiredSessionId?: string;
  run: () => Promise<T>;
}): Promise<T> {
  const { preemption } = params;
  let timedOut = false;
  const timeoutError = new SessionMutationPreemptTimeoutError(
    preemption.sessionKey,
    preemption.kind,
  );
  const timeout = createDeferredCore<never>();
  const timer =
    preemption.timeoutMs === null
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          timeout.reject(timeoutError);
        }, preemption.timeoutMs);
  timer?.unref?.();
  const task = (async () => {
    // A failed Stop must still join effects it interrupted before releasing the mutation.
    const settlements = await waitUnlessAborted(
      Promise.allSettled([preemption.settlement, params.effectsSettled]),
      params.signal,
    );
    for (const settlement of settlements) {
      if (settlement.status === "rejected") {
        throw settlement.reason;
      }
    }
    return await runAfterRetiringSessionSources(
      params.targets,
      params.requiredSessionId,
      async () => {
        if (timedOut) {
          throw timeoutError;
        }
        clearTimeout(timer);
        params.signal?.throwIfAborted();
        return await params.run();
      },
      params.signal,
    );
  })();
  try {
    return await Promise.race([task, timeout.promise]);
  } finally {
    clearTimeout(timer);
  }
}
