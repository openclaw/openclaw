/** One controller-owned steer of a reserved input into its captured execution owner. */
import { bindWorkerToolPreparation } from "../agents/harness/host-private-capabilities.js";
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
      errorMessage?: string;
    };

/** Admits the input behind older reservations and injects it; custody settles on the native outcome. */
export async function beginSessionControllerSteer(
  params: SessionControllerSteerParams,
): Promise<ReplyMessageInjectionAttempt | undefined> {
  const injection = beginSessionControllerSourceInjection(params.input);
  if (!(await injection.admit())) {
    return undefined;
  }
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
    return accepted;
  });
  void acceptance.catch(() => {});
  const outcome = attempt.outcome.then(
    async (nativeOutcome) => {
      // Native ownership and an indeterminate commit are never replayable.
      let accepted: boolean;
      try {
        accepted = await acceptance;
      } catch (error) {
        // The native outcome has now settled; an unknown ACK never permits replay.
        injection.finish(true);
        throw error;
      }
      if (nativeOutcome.status === "rejected" && nativeOutcome.withdrawn) {
        injection.withdraw();
        injection.finish(false);
        return nativeOutcome;
      }
      injection.finish(
        accepted || nativeOutcome.status === "accepted" || nativeOutcome.status === "indeterminate",
      );
      return nativeOutcome;
    },
    (error: unknown) => {
      // An exceptional result after handoff cannot prove that input was rejected.
      injection.finish(true);
      throw error;
    },
  );
  void outcome.catch(() => {});
  return { ...attempt, acceptance, outcome };
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
    const { reason, errorMessage } = finalization.outcome;
    return { status: "rejected", reason, ...(errorMessage ? { errorMessage } : {}) };
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
