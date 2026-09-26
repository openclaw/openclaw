import {
  collectErrorGraphCandidates,
  toErrorObject,
} from "@openclaw/normalization-core/error-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { isEmbeddedRunHandleCompacting } from "../../agents/embedded-agent-runner/runs.probes.js";
import {
  QuestionAnswerUnconfirmedError,
  QuestionDispatchRefusedError,
  QuestionDispatchUnsupportedError,
} from "../../agents/harness/gateway-question-dispatch.js";
import { SessionPendingInputCustodyError } from "../../config/sessions/session-pending-input-custody-error.js";
import { getAgentRunContext } from "../../infra/agent-run-registry.js";
import { hasPromptImageInput } from "../../media/prompt-image-input.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  createMessageInjectionAuthority,
  MessageInjectionAuthorityError,
} from "./message-injection-authority.js";
import {
  replyMessageInjectionTargetOperation,
  type ReplyBackendHandle,
  type ReplyBackendMessageInjection,
  type ReplyBackendQueueMessageMismatch,
  type ReplyBackendQueueMessageOptions,
  type ReplyBackendQueueMessageResult,
  type ReplyMessageInjectionAttempt,
  type ReplyMessageInjectionOptions,
  type ReplyMessageInjectionOutcome,
  type ReplyMessageInjectionRejectionReason,
  type ReplyMessageInjectionTarget,
  type ReplyOperation,
  type ReplyToolAuthorityOverlay,
} from "./reply-run-registry.contracts.js";
import {
  getAttachedBackend,
  isReplyRunEvidenceStale,
  replyRunState,
} from "./reply-run-registry.state.js";

export function resolveReplyBackendQueueMessageMismatch(
  backend: Pick<
    ReplyBackendHandle,
    | "sourceReplyDeliveryMode"
    | "terminalReplyExpectation"
    | "supportsQueueMessageImages"
    | "taskSuggestionDeliveryMode"
    | "toolAuthorityFingerprint"
    | "runId"
  >,
  options?: ReplyBackendQueueMessageOptions,
  authority?: { toolAuthorityFingerprint?: string },
): ReplyBackendQueueMessageMismatch | undefined {
  if (options?.isInboundUserMessage === true) {
    const runContext = backend.runId ? getAgentRunContext(backend.runId) : undefined;
    // A new human turn must keep its own visible answer. Steering shares the
    // active turn's output owner, so leave this input with FIFO followup admission.
    if (runContext?.isControlUiVisible === false && runContext.projectSessionMessages === false) {
      return "input_visibility_mismatch";
    }
    const activeFingerprint = normalizeOptionalString(
      backend.toolAuthorityFingerprint ?? authority?.toolAuthorityFingerprint,
    );
    const incomingFingerprint = normalizeOptionalString(options.toolAuthorityFingerprint);
    if (!activeFingerprint || !incomingFingerprint || activeFingerprint !== incomingFingerprint) {
      return "tool_authority_mismatch";
    }
  }
  if (
    options?.terminalReplyExpectation !== undefined &&
    options.terminalReplyExpectation !== (backend.terminalReplyExpectation ?? "required")
  ) {
    return "reply_expectation_mismatch";
  }
  if (hasPromptImageInput(options) && backend.supportsQueueMessageImages !== true) {
    return "image_input_unsupported";
  }
  if (
    options?.sourceReplyDeliveryMode === "message_tool_only" &&
    backend.sourceReplyDeliveryMode !== "message_tool_only"
  ) {
    return "source_reply_delivery_mode_mismatch";
  }
  // User turns carry this own property even when disabled; internal wakeups
  // omit it so they inherit the active run's already-negotiated tool surface.
  if (
    options !== undefined &&
    Object.hasOwn(options, "taskSuggestionDeliveryMode") &&
    options?.taskSuggestionDeliveryMode !== backend.taskSuggestionDeliveryMode
  ) {
    return "task_suggestion_delivery_mode_mismatch";
  }
  return undefined;
}

function resolveReplyBackendMessageInjection(
  backend: ReplyBackendHandle,
  canInject: () => boolean,
  sourceBound: boolean,
):
  | (ReplyBackendMessageInjection &
      Pick<ReplyBackendHandle, "claimPendingUserInputAnswer" | "cancelPendingUserInput">)
  | undefined {
  const guarded = backend.messageInjectionV2;
  if (guarded?.version === 2) {
    const assertCurrent = createMessageInjectionAuthority(canInject);
    const authorityKind = sourceBound ? "source-bound" : "run";
    return {
      isAvailable: () => guarded.isAvailable(),
      queueMessage: (text, options) =>
        guarded.queueMessage(text, options, assertCurrent, authorityKind),
      claimPendingUserInputAnswer: guarded.claimPendingUserInputAnswer
        ? (text, options) =>
            guarded.claimPendingUserInputAnswer!(text, options, assertCurrent, authorityKind)
        : undefined,
      cancelPendingUserInput: guarded.cancelPendingUserInput
        ? (resolvedBy) => guarded.cancelPendingUserInput!(resolvedBy, assertCurrent, authorityKind)
        : undefined,
    };
  }
  if (sourceBound) {
    createMessageInjectionAuthority(canInject)();
    return undefined;
  }
  if (backend.messageInjection) {
    const injection = backend.messageInjection;
    return {
      isAvailable: () => injection.isAvailable(),
      queueMessage: (text, options) => injection.queueMessage(text, options),
      claimPendingUserInputAnswer: backend.claimPendingUserInputAnswer?.bind(backend),
      cancelPendingUserInput: backend.cancelPendingUserInput?.bind(backend),
    };
  }
  if (!backend.queueMessage) {
    return undefined;
  }
  return {
    claimPendingUserInputAnswer: backend.claimPendingUserInputAnswer?.bind(backend),
    cancelPendingUserInput: backend.cancelPendingUserInput?.bind(backend),
    isAvailable: () => {
      if (backend.isStopped) {
        return !backend.isStopped();
      }
      // Legacy handles already expose the only capability that matters here:
      // queueMessage. Let the runtime accept or reject instead of guessing from
      // unrelated token-stream state.
      return true;
    },
    queueMessage: (text, options) =>
      options ? backend.queueMessage!(text, options) : backend.queueMessage!(text),
  };
}

export function resolveReplyMessageInjectionRejection(params: {
  operation: ReplyOperation | undefined;
  options?: ReplyBackendQueueMessageOptions;
  allowPendingUserInputAnswer?: false;
  assertCurrent?: () => void;
}):
  | {
      reason: ReplyMessageInjectionRejectionReason;
      errorMessage?: string;
      backend?: ReplyBackendHandle;
      cancelPendingUserInput?: ReplyBackendHandle["cancelPendingUserInput"];
    }
  | { backend: ReplyBackendHandle; injection: ReplyBackendMessageInjection } {
  const { operation } = params;
  if (!operation || replyRunState.activeRunsByKey.get(operation.key) !== operation) {
    return { reason: "no_active_run" };
  }
  if (operation.result || operation.phase !== "running") {
    return { reason: "not_running" };
  }
  if (isReplyRunEvidenceStale(operation)) {
    return { reason: "stale_run" };
  }
  const backend = getAttachedBackend(operation);
  const canInject = () => {
    params.assertCurrent?.();
    return (
      replyRunState.activeRunsByKey.get(operation.key) === operation &&
      !operation.result &&
      operation.phase === "running" &&
      getAttachedBackend(operation) === backend
    );
  };
  const injection = backend
    ? resolveReplyBackendMessageInjection(backend, canInject, params.assertCurrent !== undefined)
    : undefined;
  if (!backend || !injection) {
    return { reason: "injection_unavailable" };
  }
  try {
    if (
      !injection.isAvailable() ||
      isEmbeddedRunHandleCompacting(operation.sessionId, backend) !== false
    ) {
      return { reason: "injection_unavailable" };
    }
  } catch (error) {
    return { reason: "injection_unavailable", errorMessage: String(error) };
  }
  const mismatch = resolveReplyBackendQueueMessageMismatch(backend, params.options, operation);
  const activeFingerprint = normalizeOptionalString(
    backend.toolAuthorityFingerprint ?? operation.toolAuthorityFingerprint,
  );
  const pendingInputAuthorityProven =
    activeFingerprint !== undefined &&
    normalizeOptionalString(params.options?.pendingInputAuthorityFingerprint) === activeFingerprint;
  // Hidden coordination can settle its own question, but cannot own the visible
  // answer to a new human turn through ordinary steering.
  const hiddenPendingInputAuthorized =
    mismatch === "input_visibility_mismatch" &&
    params.options?.isInboundUserMessage === true &&
    backend.messageInjectionV2?.version === 2 &&
    activeFingerprint !== undefined &&
    (pendingInputAuthorityProven ||
      normalizeOptionalString(params.options.toolAuthorityFingerprint) === activeFingerprint);
  if (
    ((mismatch === "tool_authority_mismatch" && pendingInputAuthorityProven) ||
      hiddenPendingInputAuthorized) &&
    params.allowPendingUserInputAnswer !== false &&
    !hasPromptImageInput(params.options) &&
    injection.claimPendingUserInputAnswer
  ) {
    return {
      backend,
      injection: {
        isAvailable: () => true,
        queueMessage: async (text, options) => {
          if (!(await injection.claimPendingUserInputAnswer?.(text, options))) {
            throw new Error("pending user input was not accepted");
          }
        },
      },
    };
  }
  return mismatch
    ? {
        reason: mismatch,
        backend,
        cancelPendingUserInput:
          mismatch !== "input_visibility_mismatch" || hiddenPendingInputAuthorized
            ? injection.cancelPendingUserInput
            : undefined,
      }
    : { backend, injection };
}

function resolveReplyMessageInjectionFailure(
  error: unknown,
  params: { assertCurrent?: () => void; accepted: boolean },
): ReplyMessageInjectionOutcome | undefined {
  const { assertCurrent, accepted } = params;
  const candidates = collectErrorGraphCandidates(error, (current) => [current.cause]);
  const unsupported = candidates.findLast(
    (candidate) => candidate instanceof QuestionDispatchUnsupportedError,
  );
  const unconfirmed = candidates.findLast(
    (candidate) => candidate instanceof QuestionAnswerUnconfirmedError,
  );
  if (unconfirmed) {
    return { status: "indeterminate", errorMessage: unconfirmed.message };
  }
  const refusal = candidates.findLast(
    (candidate) =>
      candidate instanceof MessageInjectionAuthorityError ||
      ((assertCurrent !== undefined || unsupported !== undefined) &&
        ((candidate instanceof QuestionDispatchRefusedError &&
          !(candidate instanceof QuestionDispatchUnsupportedError)) ||
          candidate instanceof SessionPendingInputCustodyError)),
  );
  if (unsupported && !refusal && !accepted) {
    try {
      assertCurrent?.();
    } catch (sourceError) {
      return {
        status: "failed",
        error: toErrorObject(sourceError, "Message source authority is no longer current"),
      };
    }
    return { status: "rejected", reason: "injection_unavailable" };
  }
  const authorityError = refusal ?? unsupported;
  if (
    authorityError instanceof MessageInjectionAuthorityError ||
    authorityError instanceof QuestionDispatchRefusedError ||
    authorityError instanceof SessionPendingInputCustodyError
  ) {
    // SQL and runtime wrappers retain the original cause. Never turn an owner
    // refusal into fallback, or downgrade an already reported acceptance.
    return {
      status: "failed",
      error:
        authorityError instanceof MessageInjectionAuthorityError &&
        authorityError.cause instanceof Error
          ? authorityError.cause
          : authorityError,
    };
  }
  return undefined;
}

export function beginReplyMessageInjectionTarget(
  target: ReplyMessageInjectionTarget,
  text: string,
  options?: ReplyMessageInjectionOptions,
): ReplyMessageInjectionAttempt {
  const operation = target[replyMessageInjectionTargetOperation];
  const { toolAuthorityOverlay, assertCurrent, allowPendingUserInputAnswer, ...backendOptions } =
    options ?? {};
  const projectedToolAuthorityFingerprint = toolAuthorityOverlay
    ? operation.projectToolAuthorityFingerprint(toolAuthorityOverlay)
    : backendOptions.toolAuthorityFingerprint;
  const queueOptions: ReplyBackendQueueMessageOptions | undefined = options
    ? {
        ...backendOptions,
        ...(toolAuthorityOverlay
          ? { toolAuthorityFingerprint: projectedToolAuthorityFingerprint }
          : {}),
      }
    : undefined;
  const resolved = resolveReplyMessageInjectionRejection({
    operation,
    options: queueOptions,
    allowPendingUserInputAnswer,
    assertCurrent,
  });
  if (!("injection" in resolved)) {
    const immediateRejection = {
      status: "rejected" as const,
      reason: resolved.reason,
      ...(resolved.errorMessage ? { errorMessage: resolved.errorMessage } : {}),
    };
    const cancelPendingImage =
      options?.isInboundUserMessage === true &&
      hasPromptImageInput(options) &&
      (resolved.reason === "tool_authority_mismatch" ||
        resolved.reason === "input_visibility_mismatch" ||
        resolved.reason === "image_input_unsupported")
        ? resolved.cancelPendingUserInput
        : undefined;
    let outcome: Promise<ReplyMessageInjectionOutcome> = Promise.resolve(immediateRejection);
    if (cancelPendingImage) {
      const onCancellationError = (error: unknown): ReplyMessageInjectionOutcome => {
        const failure = resolveReplyMessageInjectionFailure(error, {
          assertCurrent,
          accepted: false,
        });
        if (!failure) {
          throw error;
        }
        return failure;
      };
      try {
        outcome = Promise.resolve(cancelPendingImage("image-reply")).then(
          () => immediateRejection,
          onCancellationError,
        );
      } catch (error) {
        outcome = Promise.resolve(onCancellationError(error));
      }
    }
    return {
      targetRunId: target.runId,
      acceptance: outcome.then(
        (result) => result.status === "indeterminate",
        () => false,
      ),
      outcome,
    };
  }
  const targetRunId = normalizeOptionalString(resolved.backend.runId);
  const userTurnTranscriptRecorder = queueOptions?.userTurnTranscriptRecorder;
  // The backend selected at the final admission check owns steering identity.
  // Durable provenance is confirmed only after this exact queue operation proves
  // transcript commitment; acceptance alone is insufficient.
  // Injection is user input, not run evidence: stamping activity here would let
  // sub-10-minute user messages re-arm a wedged run's staleness window forever.
  // Invoke before the first await. The capability owns the final synchronous
  // admission check, matching Codex's active-turn lock boundary.
  const acceptance = createDeferredCore<boolean>();
  let acceptanceSettled = false;
  const settleAcceptance = (accepted: boolean) => {
    if (acceptanceSettled) {
      return;
    }
    acceptanceSettled = true;
    acceptance.resolve(accepted);
    queueOptions?.onQueueAccepted?.(accepted);
  };
  const runtimeQueueOptions: ReplyBackendQueueMessageOptions = {
    ...queueOptions,
    // Admission above checks the human principal; the runtime must not interpret
    // an authorized status control as an answer to ask_user.
    ...(allowPendingUserInputAnswer === false ? { isInboundUserMessage: false } : {}),
    onQueueAccepted: (accepted) => {
      // Rejection is provisional until the outcome rules out an uncertain question
      // dispatch. Forwarding false early would release the parked input for replay.
      if (accepted) {
        settleAcceptance(true);
      }
    },
  };
  const failed = (error: unknown): ReplyMessageInjectionOutcome => {
    const outcome: ReplyMessageInjectionOutcome = resolveReplyMessageInjectionFailure(error, {
      assertCurrent,
      accepted: acceptanceSettled,
    }) ?? { status: "rejected", reason: "runtime_rejected", errorMessage: String(error) };
    settleAcceptance(outcome.status === "indeterminate");
    return outcome;
  };
  let queued: Promise<void | ReplyBackendQueueMessageResult>;
  try {
    queued = resolved.injection.queueMessage(text, runtimeQueueOptions);
  } catch (error) {
    return {
      targetRunId,
      acceptance: acceptance.promise,
      outcome: Promise.resolve(failed(error)),
    };
  }
  const outcome = queued.then(async (result): Promise<ReplyMessageInjectionOutcome> => {
    settleAcceptance(true);
    if (
      targetRunId &&
      queueOptions?.waitForTranscriptCommit === true &&
      result?.transcriptCommit !== "unconfirmed"
    ) {
      await userTurnTranscriptRecorder?.confirmSteerTargetRunIdForPersistence?.(targetRunId);
    }
    return result ? { status: "accepted", result } : { status: "accepted" };
  }, failed);
  return {
    targetRunId,
    acceptance: acceptance.promise,
    outcome,
  };
}

/** Claims only a pending user-input request on one exact active reply operation. */
export async function claimPendingReplyMessageInjectionTarget(params: {
  target: ReplyMessageInjectionTarget;
  text: string;
  options: Omit<ReplyMessageInjectionOptions, "toolAuthorityOverlay"> & {
    toolAuthorityOverlay: ReplyToolAuthorityOverlay;
  };
  assertSourceCurrent: () => void;
  assertPreparedCurrent?: () => Promise<void>;
}): Promise<boolean> {
  const operation = params.target[replyMessageInjectionTargetOperation];
  if (
    replyRunState.activeRunsByKey.get(operation.key) !== operation ||
    operation.result ||
    operation.phase !== "running" ||
    isReplyRunEvidenceStale(operation)
  ) {
    return false;
  }
  const backend = getAttachedBackend(operation);
  const guarded = backend?.messageInjectionV2;
  if (!backend || guarded?.version !== 2 || !guarded.claimPendingUserInputAnswer) {
    return false;
  }
  const canInject = () => {
    params.assertSourceCurrent();
    return (
      replyRunState.activeRunsByKey.get(operation.key) === operation &&
      !operation.result &&
      operation.phase === "running" &&
      getAttachedBackend(operation) === backend
    );
  };
  const assertCurrent = createMessageInjectionAuthority(canInject);
  const assertTargetCurrent = () => {
    try {
      assertCurrent();
    } catch (error) {
      throw new QuestionDispatchRefusedError(
        error instanceof Error ? error.message : "question answer authority refused",
        { cause: error },
      );
    }
  };
  assertTargetCurrent();
  try {
    if (!guarded.isAvailable()) {
      return false;
    }
  } catch {
    return false;
  }
  const { toolAuthorityOverlay, ...backendOptions } = params.options;
  const projectedToolAuthorityFingerprint =
    operation.projectToolAuthorityFingerprint(toolAuthorityOverlay);
  const creatorToolAuthorityFingerprint = normalizeOptionalString(
    backend.toolAuthorityFingerprint ?? operation.toolAuthorityFingerprint,
  );
  const assertClaimCurrent = () => {
    assertTargetCurrent();
    if (
      !creatorToolAuthorityFingerprint ||
      projectedToolAuthorityFingerprint !== creatorToolAuthorityFingerprint
    ) {
      throw new QuestionDispatchRefusedError(
        "question answer caller policy does not match its creator",
      );
    }
    assertTargetCurrent();
  };
  // An absent question must fall through as an ordinary message. V2 sinks call
  // this assertion only after they find and reserve a real pending input, then
  // again at final I/O; projection itself still receives an immediate liveness check.
  const claimOptions = {
    ...backendOptions,
    toolAuthorityFingerprint: projectedToolAuthorityFingerprint,
  };
  assertTargetCurrent();
  if (!params.assertPreparedCurrent) {
    return guarded.claimPendingUserInputAnswer(
      params.text,
      claimOptions,
      assertClaimCurrent,
      "source-bound",
    );
  }
  return guarded.claimPendingUserInputAnswer(
    params.text,
    claimOptions,
    assertClaimCurrent,
    "source-bound",
    params.assertPreparedCurrent,
  );
}

/** Finalize adoption and cleanup on the captured operation without rediscovery. */
export async function finalizeReplyMessageInjectionAttempt(params: {
  attempt: ReplyMessageInjectionAttempt;
  target: ReplyMessageInjectionTarget;
  inboundAudio?: boolean;
  /** Status-only controls cannot cancel independent work when their receipt is uncertain. */
  abortOnUnconfirmedTranscript?: false;
  onOutcome?: (outcome: "accepted" | "indeterminate") => void;
  onAdopted?: () => void | Promise<void>;
  shouldAbortOnAdoptionError?: (error: unknown) => boolean;
}) {
  const outcome = await params.attempt.outcome;
  if (outcome.status === "failed") {
    throw outcome.error;
  }
  if (outcome.status === "rejected") {
    return { status: "rejected" as const, outcome, targetRunId: params.attempt.targetRunId };
  }
  // Retained input custody must be visible before fallible source adoption.
  params.onOutcome?.(outcome.status);
  if (outcome.status === "indeterminate") {
    let adoptionError: unknown;
    try {
      await params.onAdopted?.();
    } catch (error) {
      adoptionError = error;
    }
    // Unknown input retains custody but has no authority to abort independent
    // backing work, including when the source's later adoption fails.
    return {
      status: "indeterminate" as const,
      outcome,
      targetRunId: params.attempt.targetRunId,
      adoptionError,
    };
  }
  recordAcceptedReplyMessageInjectionTarget(params.target, {
    inboundAudio: params.inboundAudio,
  });
  let aborted =
    outcome.result?.transcriptCommit === "unconfirmed" &&
    params.abortOnUnconfirmedTranscript !== false;
  if (aborted) {
    abortReplyMessageInjectionTarget(params.target);
  }
  let adoptionError: unknown;
  try {
    await params.onAdopted?.();
  } catch (error) {
    adoptionError = error;
    if (params.shouldAbortOnAdoptionError?.(error)) {
      abortReplyMessageInjectionTarget(params.target);
      aborted = true;
    }
  }
  return {
    status: "accepted" as const,
    outcome,
    targetRunId: params.attempt.targetRunId,
    aborted,
    ...(adoptionError === undefined ? {} : { adoptionError }),
  };
}

/** Abort only the operation captured by this target; never a same-key successor. */
function abortReplyMessageInjectionTarget(target: ReplyMessageInjectionTarget): boolean {
  return target[replyMessageInjectionTargetOperation].abortByUser();
}

/** Record accepted input on the exact operation without rediscovering its session slot. */
function recordAcceptedReplyMessageInjectionTarget(
  target: ReplyMessageInjectionTarget,
  options?: { inboundAudio?: boolean },
): void {
  const operation = target[replyMessageInjectionTargetOperation];
  operation.recordActivity();
  if (options?.inboundAudio === true) {
    operation.markAcceptedSteeredInboundAudio();
  }
}
