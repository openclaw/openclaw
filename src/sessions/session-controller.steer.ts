/** One controller-owned steer of a reserved input into its captured execution owner. */
import { bindWorkerToolPreparation } from "../agents/harness/host-private-capabilities.js";
import {
  admitFollowupRunLifecycle,
  completeFollowupRunLifecycle,
} from "../auto-reply/reply/queue/lifecycle.js";
import { diagnosticLogger } from "../logging/diagnostic-runtime.js";
import type {
  ReplySteerNowResult,
  ReplySteerNowState,
} from "./session-controller.backend-contracts.js";
import { replyMessageInjectionTargetOwner } from "./session-controller.contracts.js";
import type {
  ReplyBackendQueueMessageResult,
  ReplyMessageInjectionAttempt,
  ReplyMessageInjectionOptions,
  ReplyMessageInjectionOutcome,
  ReplyMessageInjectionTarget,
  ReplyOperation,
  SessionControllerInput,
} from "./session-controller.contracts.js";
import {
  beginSessionControllerSourceInjection,
  retireSessionControllerInput,
} from "./session-controller.mailbox-source.js";
import { reserveSessionControllerSource } from "./session-controller.mailbox.js";
import {
  beginReplyMessageInjectionTarget,
  captureReplyMessageInjectionTarget,
  finalizeReplyMessageInjectionAttempt,
} from "./session-controller.message-injection.js";
import {
  getSessionControllerEntryForOperation,
  isCurrentSessionControllerOperation,
} from "./session-controller.state.js";

type SessionControllerSteerParams = {
  input: SessionControllerInput;
  target: ReplyMessageInjectionTarget;
  text: string;
  options: ReplyMessageInjectionOptions;
  retry?: NonNullable<SessionControllerInput["steerNow"]>["retry"];
  retryWithdrawnSteer?: boolean;
};

export type SessionControllerSteerResult =
  | { status: "accepted"; targetRunId?: string; result?: ReplyBackendQueueMessageResult }
  /** Consumed without a confirmed commit; never replayable. */
  | { status: "indeterminate"; targetRunId?: string; errorMessage: string }
  /** The input stays with the mailbox, or was retired by its own cancellation. */
  | {
      status: "rejected";
      reason:
        | Extract<ReplyMessageInjectionOutcome, { status: "rejected" }>["reason"]
        | "admission_declined";
      runtimeReason?: Extract<
        ReplyMessageInjectionOutcome,
        { status: "rejected" }
      >["runtimeReason"];
      errorMessage?: string;
    };

/** Admits the input behind older reservations and injects it; custody settles on the native outcome. */
export async function beginSessionControllerSteer(
  params: SessionControllerSteerParams,
): Promise<ReplyMessageInjectionAttempt | undefined> {
  const injection = beginSessionControllerSourceInjection(params.input, {
    retryWithdrawnSteer: params.retryWithdrawnSteer,
  });
  if (!(await injection.admit())) {
    return undefined;
  }
  const pending = params.input.injection;
  const queueIdentity = params.options.queueIdentity ?? params.input.instance.id;
  let attempt: ReplyMessageInjectionAttempt;
  try {
    const assertInputCurrent = () => {
      try {
        params.input.abortSignal.throwIfAborted();
        params.input.sourceAdapter?.authority?.assertCurrent();
        params.options.abortSignal?.throwIfAborted();
      } catch (error) {
        // A revoked source cannot become a runnable followup when preparation unwinds.
        retireSessionControllerInput(params.input);
        throw error;
      }
    };
    const preparation = params.options.toolAuthorityPreparation;
    const prepared = bindWorkerToolPreparation(
      {
        assertCurrent: () => {
          assertInputCurrent();
          preparation?.assertCurrent();
        },
        compatAssertCurrent: () => {
          assertInputCurrent();
          preparation?.compatAssertCurrent();
        },
        prepareCurrent: async () => {
          await preparation?.prepareCurrent();
          assertInputCurrent();
        },
      },
      preparation ? [preparation] : [],
    );
    assertInputCurrent();
    params.options.assertCurrent?.();
    attempt = await beginReplyMessageInjectionTarget(params.target, params.text, {
      ...params.options,
      queueIdentity,
      // Deferred message preparation updates these facts on the caller's options.
      get toolAuthorityOverlay() {
        return params.options.toolAuthorityOverlay;
      },
      get userTurnTranscriptRecorder() {
        return params.options.userTurnTranscriptRecorder;
      },
      abortSignal: params.options.abortSignal
        ? AbortSignal.any([params.input.abortSignal, params.options.abortSignal])
        : params.input.abortSignal,
      toolAuthorityPreparation: {
        ...prepared,
        authorityKind:
          preparation?.authorityKind ?? (params.options.assertCurrent ? "source-bound" : "run"),
        ...(preparation?.prepareMessage ? { prepareMessage: preparation.prepareMessage } : {}),
      },
    });
  } catch (error) {
    injection.finish(false);
    throw error;
  }
  // Failed acknowledgement does not settle accepted native work.
  const acceptance = attempt.acceptance.then((accepted) => {
    injection.accepted(accepted);
    if (accepted && pending && params.input.injection === pending && !params.retryWithdrawnSteer) {
      params.input.steerNow = { target: params.target, queueIdentity, retry: params.retry };
    }
    return accepted;
  });
  void acceptance.catch(() => {});
  const finish = async (consumed: boolean) => {
    try {
      if (consumed && params.retryWithdrawnSteer && params.input.source) {
        try {
          await admitFollowupRunLifecycle(params.input.source);
        } finally {
          completeFollowupRunLifecycle(params.input.source, "consumed");
        }
      }
    } finally {
      injection.finish(consumed);
    }
  };
  const outcome = attempt.outcome.then(
    async (nativeOutcome) => {
      try {
        await acceptance;
      } catch (error) {
        // The native outcome has now settled; an unknown ACK never permits replay.
        await finish(true);
        throw error;
      }
      // The failure owner already retains ambiguous acceptance and releases proven withdrawal.
      await finish(nativeOutcome.status === "accepted" || nativeOutcome.status === "indeterminate");
      if (nativeOutcome.status === "rejected" && nativeOutcome.errorMessage) {
        diagnosticLogger.warn("steering runtime rejected input", {
          sessionKey: params.input.mailbox.key,
          activeRunId: attempt.targetRunId,
          reason: nativeOutcome.reason,
          ...(nativeOutcome.runtimeReason ? { runtimeReason: nativeOutcome.runtimeReason } : {}),
          error: nativeOutcome.errorMessage.slice(0, 512),
        });
      }
      return nativeOutcome;
    },
    async (error: unknown) => {
      // An exceptional result after handoff cannot prove that input was rejected.
      await finish(true);
      throw error;
    },
  );
  void outcome.catch(() => {});
  return { ...attempt, acceptance, outcome };
}

function resolvePendingSteerControl(input: SessionControllerInput) {
  const pending = input.steerNow;
  const queuedFollowup = input.phase === "waiting" && input.custody.enqueued === true;
  if (
    !pending ||
    input.abortSignal.aborted ||
    input.retirementRequested ||
    (!input.injection && !queuedFollowup)
  ) {
    return undefined;
  }
  const resolved = pending.target[replyMessageInjectionTargetOwner].resolve({});
  return "injection" in resolved
    ? { pending, control: resolved.backend.messageInjectionV2?.steerNow, queuedFollowup }
    : undefined;
}

/** Projects the captured execution's capability; never substitutes the session's next run. */
export function readSessionControllerSteerNow(
  input: SessionControllerInput,
): ReplySteerNowState | undefined {
  const selected = resolvePendingSteerControl(input);
  if (selected?.queuedFollowup && !selected.pending.retry) {
    return { status: "blocked", tools: [] };
  }
  return selected
    ? (selected.control?.read(selected.pending.queueIdentity, selected.queuedFollowup) ??
        (selected.control ? undefined : { status: "blocked", tools: [] }))
    : undefined;
}

/** Re-admit a withdrawn input before interruption; every caller retains current write authority. */
export async function sendSessionControllerSteerNow(
  input: SessionControllerInput,
  assertCurrent: () => void = () => {},
): Promise<ReplySteerNowResult> {
  assertCurrent();
  const selected = resolvePendingSteerControl(input);
  if (!selected) {
    return { status: "settled", tools: [] };
  }
  input.sourceAdapter?.authority?.assertCurrent();
  const { pending, queuedFollowup } = selected;
  if (pending.result) {
    return pending.result;
  }
  const interrupt = (): ReplySteerNowResult => {
    assertCurrent();
    input.sourceAdapter?.authority?.assertCurrent();
    const current = resolvePendingSteerControl(input);
    if (!current) {
      return { status: "settled", tools: [] };
    }
    const result = current.control?.send(pending.queueIdentity) ?? {
      status: "unavailable" as const,
      tools: [],
    };
    if (result.status === "interrupted" || result.status === "idle") {
      pending.result = result;
    }
    return result;
  };
  if (queuedFollowup) {
    const state = selected.control?.read(pending.queueIdentity, true);
    if (state?.status === "blocked") {
      return { status: "blocked", tools: state.tools };
    }
    const retry = pending.retry;
    if (!state || !retry) {
      return { status: "unavailable", tools: [] };
    }
    const sending = (async (): Promise<ReplySteerNowResult> => {
      const attempt = await retry(assertCurrent);
      return attempt && (await attempt.acceptance)
        ? interrupt()
        : { status: "unavailable", tools: [] };
    })().finally(() => {
      if (pending.result === sending) {
        pending.result = undefined;
      }
    });
    pending.result = sending;
    return sending;
  }
  return interrupt();
}

/** Steers once into the exact target (default: the input owner's current turn); authority failures throw. */
export async function submitSessionControllerSteer(
  params: Omit<SessionControllerSteerParams, "target"> & {
    target?: ReplyMessageInjectionTarget;
    /** Status-only and completion inputs cannot abort the target when its commit is unconfirmed. */
    abortOnUnconfirmedTranscript?: false;
  },
): Promise<SessionControllerSteerResult> {
  const active = params.input.mailbox.owner.active;
  const target = params.target ?? captureReplyMessageInjectionTarget(active);
  if (!target) {
    return { status: "rejected", reason: active ? "injection_unavailable" : "no_active_run" };
  }
  const attempt = await beginSessionControllerSteer({ ...params, target });
  if (!attempt) {
    return { status: "rejected", reason: "admission_declined" };
  }
  const finalization = await finalizeReplyMessageInjectionAttempt({
    attempt,
    target,
    inboundAudio: params.options.inboundAudio,
  });
  const { targetRunId } = finalization;
  if (finalization.status === "rejected") {
    return finalization.outcome;
  }
  if (finalization.status === "indeterminate") {
    return {
      status: "indeterminate",
      targetRunId,
      errorMessage: finalization.outcome.errorMessage,
    };
  }
  return { status: "accepted", targetRunId, result: undefined };
}

/**
 * Steers in-process input into one exact operation through a steer input reserved on
 * that operation's own mailbox. Target capture and reservation happen synchronously,
 * before the first await. The reservation never outlives the call: a refused steer is
 * retired, never queued as a later turn.
 */
export async function steerSessionControllerOperation(params: {
  operation: ReplyOperation | undefined;
  text: string;
  options: ReplyMessageInjectionOptions;
  abortOnUnconfirmedTranscript?: false;
}): Promise<SessionControllerSteerResult> {
  const { operation, ...steer } = params;
  const target = captureReplyMessageInjectionTarget(operation);
  if (!operation || !target) {
    const live = operation && isCurrentSessionControllerOperation(operation) && !operation.result;
    return { status: "rejected", reason: live ? "injection_unavailable" : "no_active_run" };
  }
  const owner = getSessionControllerEntryForOperation(operation);
  const input = reserveSessionControllerSource(owner.id, {
    policy: { mode: "steer" },
    target: owner.target,
  });
  try {
    return await submitSessionControllerSteer({ ...steer, input, target });
  } finally {
    retireSessionControllerInput(input);
  }
}
