import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  bindReplyQueueInputAdapter,
  bindWorkerToolPreparation,
  readReplyQueueInputAdapter,
} from "../agents/harness/host-private-capabilities.js";
import { bindPreparedToolAuthority } from "../agents/harness/tool-authority-preparation.js";
import {
  captureRequesterOrigin,
  resolveRequesterPrincipalKey,
} from "../agents/requester-origin.js";
import { hasInboundAudio } from "../auto-reply/reply/inbound-media.js";
import {
  enqueueMessageInjection,
  MessageInjectionAuthorityError,
} from "../auto-reply/reply/message-injection-authority.js";
import { hasPromptImageInput } from "../media/prompt-image-input.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  replyMessageInjectionTargetOwner,
  type ReplyBackendQueueMessageOptions,
  type ReplyMessageInjectionAttempt,
  type ReplyMessageInjectionOptions,
  type ReplyMessageInjectionOutcome,
  type ReplyMessageInjectionResolution,
  type ReplyMessageInjectionTarget,
  type ReplyOperation,
  type ReplyToolAuthorityOverlay,
  type ReplyToolAuthorityPreparation,
} from "./session-controller.contracts.js";
import { resolveReplyBackendMessageInjectionRejection } from "./session-controller.message-injection-backend.js";
import { resolveReplyMessageInjectionFailure } from "./session-controller.message-injection-failure.js";
import {
  getSessionControllerOperation,
  getAttachedBackendAttachment,
  isReplyRunEvidenceStale,
  isCurrentSessionControllerOperation,
  getSessionControllerEntryForOperation,
  readSessionControllerOperationState,
} from "./session-controller.state.js";
import { messageAdmissionsByAttachment } from "./session-controller.storage.js";
import { bindCapturedReplyToolAuthorityCallerRead } from "./session-controller.tool-authority.js";

export { canInjectReplyMessageTarget } from "./session-controller.message-injection-backend.js";

/** Capture the exact physical owner; aliases and protocol IDs are not injection authority. */
export function captureReplyMessageInjectionTarget(
  operation: ReplyOperation | undefined,
): ReplyMessageInjectionTarget | undefined {
  const resolved = resolveReplyMessageInjectionRejection({ operation });
  const backend = "injection" in resolved ? resolved.backend : undefined;
  if (!operation || !backend) {
    return undefined;
  }
  const entry = getSessionControllerEntryForOperation(operation);
  const attachment = entry.attachment;
  const backendAttachment = getAttachedBackendAttachment(operation);
  if (!attachment || !backendAttachment) {
    return undefined;
  }
  const toolAuthority = "toolAuthority" in attachment ? attachment.toolAuthority : undefined;
  const attemptAuthority = toolAuthority?.source === "attempt" ? toolAuthority : undefined;
  const participants = attemptAuthority
    ? attemptAuthority.personalToolParticipants
    : operation.personalToolParticipants;
  const sourceTurnId = entry.sourceTurnId;
  const operationState = readSessionControllerOperationState(operation);
  // Direct command delivery has no reply-dispatch trace output surface.
  const projectOverlay = (overlay: ReplyToolAuthorityOverlay) =>
    operationState?.turnKind === "direct" ? { ...overlay, traceAuthorized: false } : overlay;
  const projectAsync = async (overlay: ReplyToolAuthorityOverlay) => {
    try {
      return toolAuthority
        ? await toolAuthority.projectAsync(projectOverlay(overlay))
        : await operation.projectToolAuthorityFingerprintAsync(projectOverlay(overlay));
    } catch {
      toolAuthority?.assertActive();
      return undefined;
    }
  };
  bindCapturedReplyToolAuthorityCallerRead({
    projector: projectAsync,
    operation,
    backendAttachment,
    toolAuthority,
  });
  const target: ReplyMessageInjectionTarget = {
    [replyMessageInjectionTargetOwner]: {
      backendIdentity: backend,
      admissionIdentity: backendAttachment,
      get toolAuthorityFingerprint() {
        return "handle" in attachment
          ? backend.toolAuthorityFingerprint
          : (backend.toolAuthorityFingerprint ?? operation.toolAuthorityFingerprint);
      },
      get requesterPrincipalKey() {
        return "handle" in attachment
          ? toolAuthority?.requesterPrincipalKey
          : operation.requesterPrincipalKey;
      },
      acceptParticipant: (overlay) => participants?.accept(overlay),
      projectToolAuthorityFingerprint: (overlay) => {
        try {
          return toolAuthority
            ? toolAuthority.project(projectOverlay(overlay))
            : operation.projectToolAuthorityFingerprint(projectOverlay(overlay));
        } catch {
          toolAuthority?.assertActive();
          return undefined;
        }
      },
      projectToolAuthorityFingerprintAsync: projectAsync,
      projectRequesterToolAuthorityFingerprint: (requester) => {
        try {
          return toolAuthority?.projectRequester?.(requester);
        } catch {
          toolAuthority?.assertActive();
          return undefined;
        }
      },
      projectRequesterToolAuthorityFingerprintAsync: async (requester) => {
        try {
          return await toolAuthority?.projectRequesterAsync?.(requester);
        } catch {
          toolAuthority?.assertActive();
          return undefined;
        }
      },
      resolve: (params) =>
        getAttachedBackendAttachment(operation) === backendAttachment
          ? resolveReplyMessageInjectionRejection({ ...params, operation })
          : { reason: "no_active_run" },
      recordAccepted: (options) => {
        operation.watchdog.progress("source_arrival");
        operation.markSteeredInputAccepted({ inboundAudio: options?.inboundAudio === true });
      },
      abort: () => operation.abortByUser(),
    },
    ...(backend.runId ? { runId: backend.runId } : {}),
    ...(sourceTurnId ? { sourceTurnId } : {}),
  };
  bindReplyQueueInputAdapter(
    target[replyMessageInjectionTargetOwner],
    readReplyQueueInputAdapter(toolAuthority),
  );
  return target;
}

function resolveReplyMessageInjectionRejection(params: {
  operation: ReplyOperation | undefined;
  options?: ReplyBackendQueueMessageOptions;
  requesterToolAuthority?: ReplyMessageInjectionOptions["requesterToolAuthority"];
  inboundAudio?: boolean;
  personalToolParticipant?: ReplyMessageInjectionOptions["personalToolParticipant"];
  allowPendingUserInputAnswer?: false;
  assertCurrent?: () => void;
  preparation?: ReplyToolAuthorityPreparation;
}): ReplyMessageInjectionResolution {
  const { operation } = params;
  if (!operation || !isCurrentSessionControllerOperation(operation)) {
    return { reason: "no_active_run" };
  }
  const operationState = readSessionControllerOperationState(operation);
  if (operation.result || operationState?.phase !== "running") {
    return { reason: "not_running" };
  }
  if (isReplyRunEvidenceStale(operation)) {
    return { reason: "stale_run" };
  }
  const attachment = getSessionControllerEntryForOperation(operation).attachment;
  const backendAttachment = getAttachedBackendAttachment(operation);
  const backend = backendAttachment?.handle;
  const native = attachment && "handle" in attachment ? attachment.handle : undefined;
  // Released backends may delegate commit waiting without advertising a capability.
  const supportsTranscriptCommitWait = backend
    ? backend.supportsTranscriptCommitWait !== false
    : native?.supportsTranscriptCommitWait === true;
  if (params.options?.waitForTranscriptCommit === true && !supportsTranscriptCommitWait) {
    return { reason: "transcript_commit_wait_unsupported" };
  }
  const toolAuthority =
    attachment && "toolAuthority" in attachment ? attachment.toolAuthority : undefined;
  if (params.requesterToolAuthority) {
    if (backend?.messageInjectionV2?.version !== 2) {
      return { reason: "guarded_injection_unsupported" };
    }
    try {
      if (!toolAuthority?.acceptsRequesterOrigin(params.requesterToolAuthority.requesterOrigin)) {
        return { reason: "requester_origin_mismatch" };
      }
    } catch {
      return { reason: "requester_origin_mismatch" };
    }
    // Fresh delegation cannot borrow a pending-answer shortcut from the incumbent.
    const projected = normalizeOptionalString(params.options?.toolAuthorityFingerprint);
    if (
      !projected ||
      projected !==
        normalizeOptionalString(
          backend.toolAuthorityFingerprint ?? operation.toolAuthorityFingerprint,
        )
    ) {
      return { reason: "tool_authority_mismatch" };
    }
  }
  const canInject = () => {
    if (
      !isCurrentSessionControllerOperation(operation) ||
      operation.result ||
      operationState?.phase !== "running" ||
      getAttachedBackendAttachment(operation) !== backendAttachment
    ) {
      return false;
    }
    toolAuthority?.assertActive();
    if (
      params.requesterToolAuthority &&
      !toolAuthority?.acceptsRequesterOrigin(params.requesterToolAuthority.requesterOrigin)
    ) {
      return false;
    }
    return true;
  };
  if (operationState?.turnKind === "direct") {
    if (params.inboundAudio || hasInboundAudio({ media: params.options?.media })) {
      // Direct tool contexts cannot adopt the reply operation's dynamic audio fact.
      return { reason: "audio_input_unsupported" };
    }
  }
  return resolveReplyBackendMessageInjectionRejection({
    ...params,
    options:
      operationState?.turnKind === "direct" &&
      params.options?.isInboundUserMessage &&
      params.allowPendingUserInputAnswer !== false
        ? {
            ...params.options,
            terminalReplyExpectation:
              backend?.terminalReplyExpectation === "result-required"
                ? "result-required"
                : "required",
          }
        : params.options,
    sessionId: operation.sessionId,
    backend,
    canInject,
    toolAuthorityFingerprint: operation.toolAuthorityFingerprint,
    personalToolParticipants:
      toolAuthority?.source === "attempt"
        ? toolAuthority.personalToolParticipants
        : operation.personalToolParticipants,
  });
}

export function beginReplyMessageInjectionTarget(
  target: ReplyMessageInjectionTarget,
  text: string,
  options?: ReplyMessageInjectionOptions,
): Promise<ReplyMessageInjectionAttempt> {
  return enqueueMessageInjection(target[replyMessageInjectionTargetOwner].backendIdentity, () =>
    beginPreparedReplyMessageInjectionTarget(target, text, options),
  );
}

async function beginPreparedReplyMessageInjectionTarget(
  target: ReplyMessageInjectionTarget,
  text: string,
  options?: ReplyMessageInjectionOptions,
): Promise<ReplyMessageInjectionAttempt> {
  const owner = target[replyMessageInjectionTargetOwner];
  const assertSourceCurrent =
    options?.toolAuthorityPreparation || options?.assertCurrent
      ? () => {
          options?.toolAuthorityPreparation?.assertCurrent();
          options?.assertCurrent?.();
        }
      : undefined;
  // Losing the captured target cannot revoke a live source's separate-turn fallback.
  const assertFailureSourceCurrent = options?.assertCurrent ?? assertSourceCurrent;
  const resolvePreAcceptanceFailure = (error: unknown): ReplyMessageInjectionOutcome => {
    const failure = resolveReplyMessageInjectionFailure(error, {
      assertCurrent: assertFailureSourceCurrent,
      accepted: false,
    });
    if (failure) {
      return failure;
    }
    assertSourceCurrent?.();
    const current = owner.resolve({});
    if (
      !("injection" in current) &&
      (current.reason === "no_active_run" ||
        current.reason === "not_running" ||
        current.reason === "stale_run")
    ) {
      // Only a live source rejected before acceptance may fall back after target retirement.
      return { status: "rejected", reason: current.reason };
    }
    throw error;
  };
  let preparedText: string;
  try {
    assertSourceCurrent?.();
    preparedText = (await options?.toolAuthorityPreparation?.prepareMessage?.()) ?? text;
    assertSourceCurrent?.();
    await options?.toolAuthorityPreparation?.prepareCurrent();
    assertSourceCurrent?.();
  } catch (error) {
    const failure = resolvePreAcceptanceFailure(error);
    return {
      targetRunId: target.runId,
      acceptance: Promise.resolve(false),
      outcome: Promise.resolve(failure),
    };
  }
  // Deferred preparation may install both caller policy and a transcript recorder.
  const {
    canAdmit,
    toolAuthorityOverlay: incomingOverlay,
    allowCollaborativeSteering,
    requesterToolAuthority,
    toolAuthorityPreparation,
    personalToolParticipant,
    assertCurrent,
    allowPendingUserInputAnswer: requestedPendingUserInputAnswer,
    inboundAudio,
    ...backendOptions
  } = options ?? {};
  const incomingRequester = incomingOverlay
    ? resolveRequesterPrincipalKey({
        ...incomingOverlay,
        messageChannel: incomingOverlay.originatingChannel,
      })
    : undefined;
  if (
    !requesterToolAuthority &&
    allowCollaborativeSteering === false &&
    backendOptions.isInboundUserMessage &&
    (!incomingOverlay?.inputProvenance ||
      incomingOverlay.inputProvenance.kind === "external_user") &&
    incomingRequester &&
    owner.requesterPrincipalKey &&
    incomingRequester !== owner.requesterPrincipalKey
  ) {
    assertSourceCurrent?.();
    // Refusal belongs to this live target. A vanished or unavailable backend still
    // returns its existing fallback decision, without lending another turn's identity.
    const availability =
      canAdmit?.() === false
        ? { reason: "injection_unavailable" as const }
        : owner.resolve({ inboundAudio, assertCurrent: assertSourceCurrent });
    const acceptance = Promise.resolve(false);
    void acceptance.then((accepted) => backendOptions.onQueueAccepted?.(accepted));
    return {
      targetRunId: target.runId,
      acceptance,
      outcome: Promise.resolve({
        status: "rejected",
        reason:
          "injection" in availability ? "collaborative_steering_disabled" : availability.reason,
      }),
    };
  }
  let selectedOverlay = incomingOverlay;
  let allowPendingUserInputAnswer = requestedPendingUserInputAnswer;
  let projectedToolAuthorityFingerprint: string | undefined;
  try {
    projectedToolAuthorityFingerprint = requesterToolAuthority
      ? await owner.projectRequesterToolAuthorityFingerprintAsync(requesterToolAuthority)
      : selectedOverlay
        ? await owner.projectToolAuthorityFingerprintAsync(selectedOverlay)
        : backendOptions.toolAuthorityFingerprint;
    if (
      !requesterToolAuthority &&
      allowCollaborativeSteering &&
      backendOptions.isInboundUserMessage &&
      incomingOverlay &&
      incomingRequester &&
      owner.requesterPrincipalKey &&
      incomingRequester !== owner.requesterPrincipalKey &&
      (!projectedToolAuthorityFingerprint ||
        projectedToolAuthorityFingerprint !== owner.toolAuthorityFingerprint)
    ) {
      const collaborativeOverlay = {
        ...incomingOverlay,
        allowCollaborativeSteering: true as const,
      };
      const incumbentFingerprint =
        await owner.projectToolAuthorityFingerprintAsync(collaborativeOverlay);
      if (incumbentFingerprint && incumbentFingerprint !== projectedToolAuthorityFingerprint) {
        selectedOverlay = collaborativeOverlay;
        projectedToolAuthorityFingerprint = incumbentFingerprint;
        // Collaboration permits ordinary input, not answering or canceling another
        // requester's pending question. Compatible input keeps its strict preparation.
        allowPendingUserInputAnswer = false;
      }
    }
  } catch (error) {
    const failure = resolvePreAcceptanceFailure(error);
    return {
      targetRunId: target.runId,
      acceptance: Promise.resolve(false),
      outcome: Promise.resolve(failure),
    };
  }
  const toolAuthorityOverlay = selectedOverlay;
  const currentToolAuthorityOverlay = () => {
    const overlay = options?.toolAuthorityOverlay;
    return overlay && toolAuthorityOverlay?.allowCollaborativeSteering
      ? { ...overlay, allowCollaborativeSteering: true as const }
      : overlay;
  };
  const sourceBound =
    assertCurrent !== undefined ||
    (toolAuthorityPreparation !== undefined && toolAuthorityPreparation.authorityKind !== "run");
  assertSourceCurrent?.();
  const assertPolicy = (projected: string | undefined) => {
    assertSourceCurrent?.();
    if (!projected || projected !== projectedToolAuthorityFingerprint) {
      throw new MessageInjectionAuthorityError();
    }
  };
  const queueOptions: ReplyBackendQueueMessageOptions | undefined = options
    ? {
        ...backendOptions,
        ...(requesterToolAuthority || toolAuthorityOverlay
          ? { toolAuthorityFingerprint: projectedToolAuthorityFingerprint }
          : {}),
      }
    : undefined;
  const resolved: ReplyMessageInjectionResolution =
    canAdmit?.() === false
      ? { reason: "injection_unavailable" }
      : owner.resolve({
          options: queueOptions,
          requesterToolAuthority,
          personalToolParticipant: toolAuthorityOverlay ?? personalToolParticipant,
          inboundAudio,
          allowPendingUserInputAnswer,
          // An overlay alone does not add a caller lifetime binding to legacy input.
          assertCurrent: sourceBound ? assertSourceCurrent : undefined,
          preparation:
            requesterToolAuthority || toolAuthorityOverlay
              ? bindPreparedToolAuthority(
                  bindWorkerToolPreparation(
                    {
                      assertCurrent: () => assertSourceCurrent?.(),
                      compatAssertCurrent: () => {
                        toolAuthorityPreparation?.compatAssertCurrent();
                        const requester = options?.requesterToolAuthority;
                        const overlay = currentToolAuthorityOverlay();
                        assertPolicy(
                          requester
                            ? owner.projectRequesterToolAuthorityFingerprint(requester)
                            : overlay && owner.projectToolAuthorityFingerprint(overlay),
                        );
                      },
                      prepareCurrent: async () => {
                        await toolAuthorityPreparation?.prepareCurrent();
                        const requester = options?.requesterToolAuthority;
                        const overlay = currentToolAuthorityOverlay();
                        assertPolicy(
                          requester
                            ? await owner.projectRequesterToolAuthorityFingerprintAsync(requester)
                            : overlay &&
                                (await owner.projectToolAuthorityFingerprintAsync(overlay)),
                        );
                      },
                    },
                    toolAuthorityPreparation ? [toolAuthorityPreparation] : [],
                  ),
                )
              : toolAuthorityPreparation,
        });
  if (!("injection" in resolved)) {
    const immediateRejection = {
      status: "rejected" as const,
      reason: resolved.reason,
      ...(resolved.errorMessage ? { errorMessage: resolved.errorMessage } : {}),
    };
    const cancelPendingImage =
      allowPendingUserInputAnswer !== false &&
      options?.isInboundUserMessage === true &&
      hasPromptImageInput(options) &&
      (resolved.reason === "tool_authority_mismatch" ||
        resolved.reason === "input_visibility_mismatch" ||
        resolved.reason === "image_input_unsupported")
        ? resolved.cancelPendingUserInput
        : undefined;
    let outcome: Promise<ReplyMessageInjectionOutcome> = Promise.resolve(immediateRejection);
    if (cancelPendingImage) {
      try {
        outcome = Promise.resolve(cancelPendingImage("image-reply")).then(
          () => immediateRejection,
          resolvePreAcceptanceFailure,
        );
      } catch (error) {
        outcome = Promise.resolve(resolvePreAcceptanceFailure(error));
      }
    }
    const acceptance = outcome.then(
      (result) => result.status === "indeterminate",
      () => false,
    );
    // The caller's acceptance settles on a refusal exactly as on a runtime rejection.
    void acceptance.then((accepted) => queueOptions?.onQueueAccepted?.(accepted));
    return { targetRunId: target.runId, acceptance, outcome };
  }
  const targetRunId = normalizeOptionalString(resolved.backend.runId);
  const userTurnTranscriptRecorder = queueOptions?.userTurnTranscriptRecorder;
  const idempotencyKey = userTurnTranscriptRecorder?.message?.idempotencyKey;
  let admissions = idempotencyKey
    ? messageAdmissionsByAttachment.get(owner.admissionIdentity)
    : undefined;
  if (idempotencyKey && !admissions) {
    admissions = new Map();
    messageAdmissionsByAttachment.set(owner.admissionIdentity, admissions);
  }
  const existing = idempotencyKey && admissions?.get(idempotencyKey);
  if (existing) {
    // Receipt sharing frees FIFO during settlement without sharing caller authority.
    const acceptance = existing.acceptance.then((accepted) => {
      assertSourceCurrent?.();
      queueOptions?.onQueueAccepted?.(accepted);
      return accepted;
    });
    const outcome = existing.outcome.then((result) => {
      assertSourceCurrent?.();
      if (result.status === "accepted" || result.status === "indeterminate") {
        queueOptions?.onQueueSettled?.();
      }
      return result;
    });
    // Preserve both receipts' rejections without leaking an unobserved projection.
    void acceptance.catch(() => {});
    void outcome.catch(() => {});
    return { targetRunId: existing.targetRunId, acceptance, outcome };
  }
  // This exact backend queue operation owns steering identity; acceptance is not transcript commitment.
  // Input must not re-arm a wedged run's staleness window by stamping run activity.
  // Legacy preflight holds FIFO until synchronous admission, matching Codex's active-turn lock.
  const acceptance = createDeferredCore<boolean>();
  let acceptanceSettled = false;
  let queueAccepted = false;
  let participantRecorded = false;
  const recordParticipant = () => {
    if (participantRecorded || !queueOptions?.isInboundUserMessage) {
      return;
    }
    const participant = incomingOverlay
      ? {
          ...incomingOverlay,
          requesterOrigin: captureRequesterOrigin({
            ...incomingOverlay,
            messageChannel: incomingOverlay.originatingChannel,
            operatorProfileId: incomingOverlay.operatorAuthority?.profileId,
          }),
        }
      : personalToolParticipant;
    if (participant) {
      participantRecorded = true;
      owner.acceptParticipant?.(participant);
    }
  };
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
    // Current bundled sinks keep human custody separate from question permission.
    // Released external sinks used the category itself to gate question answers.
    ...(allowPendingUserInputAnswer === false
      ? {
          allowPendingUserInputAnswer,
          ...(readReplyQueueInputAdapter(owner) === "legacy-question-category"
            ? { isInboundUserMessage: false }
            : {}),
        }
      : {}),
    onQueueAccepted: (accepted) => {
      // Refuse only after ruling out uncertain question dispatch, which retains replay custody.
      if (accepted) {
        queueAccepted = true;
        recordParticipant();
        settleAcceptance(true);
      }
    },
  };
  const failed = (error: unknown): ReplyMessageInjectionOutcome => {
    const outcome: ReplyMessageInjectionOutcome = resolveReplyMessageInjectionFailure(error, {
      assertCurrent: assertFailureSourceCurrent,
      accepted: queueAccepted,
    }) ?? { status: "rejected", reason: "runtime_rejected", errorMessage: String(error) };
    settleAcceptance(outcome.status === "indeterminate");
    return outcome;
  };
  let outcome: Promise<ReplyMessageInjectionOutcome>;
  try {
    if (resolved.prepareQueueMessage) {
      await resolved.prepareQueueMessage();
    }
    outcome = resolved.injection
      .queueMessage(preparedText, runtimeQueueOptions)
      .then(async (result): Promise<ReplyMessageInjectionOutcome> => {
        queueAccepted = true;
        recordParticipant();
        settleAcceptance(true);
        // Receipt uncertainty retains input; it cannot authorize run cancellation or replay.
        if (result?.transcriptCommit === "unconfirmed") {
          return { status: "indeterminate", errorMessage: result.errorMessage };
        }
        if (targetRunId && queueOptions?.waitForTranscriptCommit === true) {
          await userTurnTranscriptRecorder?.confirmSteerTargetRunIdForPersistence?.(targetRunId);
        }
        return { status: "accepted" };
      })
      .catch(failed);
  } catch (error) {
    // Accepted synchronous failures retain the same receipt as asynchronous ones.
    outcome = Promise.resolve().then(() => failed(error));
  }
  const attempt = { targetRunId, acceptance: acceptance.promise, outcome };
  if (idempotencyKey && admissions) {
    const receipts = admissions;
    receipts.set(idempotencyKey, attempt);
    void outcome.then(
      (result) => {
        if (result.status === "rejected" || result.status === "failed") {
          receipts.delete(idempotencyKey);
        }
      },
      () => receipts.delete(idempotencyKey),
    );
  }
  return attempt;
}

/** Finalize adoption and cleanup on the captured owner without rediscovery. */
export async function finalizeReplyMessageInjectionAttempt(params: {
  attempt: ReplyMessageInjectionAttempt;
  target: ReplyMessageInjectionTarget;
  inboundAudio?: boolean;
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
  const accepted = outcome.status === "accepted";
  const owner = accepted ? params.target[replyMessageInjectionTargetOwner] : undefined;
  owner?.recordAccepted({ inboundAudio: params.inboundAudio });
  let aborted = false;
  let adoptionError: unknown;
  try {
    await params.onAdopted?.();
  } catch (error) {
    adoptionError = error;
    if (owner && params.shouldAbortOnAdoptionError?.(error)) {
      owner.abort();
      aborted = true;
    }
  }
  if (!accepted) {
    // Unknown input retains custody but cannot abort independent backing work.
    return {
      status: "indeterminate" as const,
      outcome,
      targetRunId: params.attempt.targetRunId,
      adoptionError,
    };
  }
  return {
    status: "accepted" as const,
    outcome,
    targetRunId: params.attempt.targetRunId,
    aborted,
    ...(adoptionError === undefined ? {} : { adoptionError }),
  };
}

/** Captures injection authority from the current direct operation owner. */
export function captureCurrentReplyMessageInjectionTarget(
  sessionKey: string,
): ReplyMessageInjectionTarget | undefined {
  return captureReplyMessageInjectionTarget(getSessionControllerOperation(sessionKey));
}
