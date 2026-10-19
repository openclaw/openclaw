import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { canSteerEmbeddedRunDuringCompaction } from "../agents/embedded-agent-runner/runs.probes.js";
import { bindWorkerToolPreparation } from "../agents/harness/host-private-capabilities.js";
import {
  bindMessageInjectionV2,
  bindPreparedToolAuthority,
  createLegacyToolAuthorityQueuePreflight,
} from "../agents/harness/tool-authority-preparation.js";
import { hasInboundAudio } from "../auto-reply/reply/inbound-media.js";
import {
  createMessageInjectionAuthority,
  enqueueMessageInjection,
  MessageInjectionAuthorityError,
} from "../auto-reply/reply/message-injection-authority.js";
import { hasPromptImageInput } from "../media/prompt-image-input.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  replyMessageInjectionTargetOwner,
  type ReplyBackendHandle,
  type ReplyBackendMessageInjection,
  type ReplyBackendQueueMessageOptions,
  type ReplyMessageInjectionAttempt,
  type ReplyMessageInjectionOptions,
  type ReplyMessageInjectionOutcome,
  type ReplyMessageInjectionResolution,
  type ReplyMessageInjectionTarget,
  type ReplyOperation,
  type ReplyTurnParticipants,
  type ReplyToolAuthorityOverlay,
  type ReplyToolAuthorityPreparation,
} from "./session-controller.contracts.js";
import {
  resolveReplyBackendQueueMessageMismatch,
  resolveReplyMessageInjectionFailure,
} from "./session-controller.message-injection-failure.js";
import {
  getSessionControllerOperation,
  getAttachedBackend,
  isReplyRunEvidenceStale,
  isCurrentSessionControllerOperation,
  getSessionControllerEntryForOperation,
  readSessionControllerOperationState,
} from "./session-controller.state.js";
import { messageAdmissionsByAttachment } from "./session-controller.storage.js";

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
  if (!attachment) {
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
  return {
    [replyMessageInjectionTargetOwner]: {
      backendIdentity: backend,
      admissionIdentity: attachment,
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
      projectToolAuthorityFingerprintAsync: async (overlay) => {
        try {
          return toolAuthority
            ? await toolAuthority.projectAsync(projectOverlay(overlay))
            : await operation.projectToolAuthorityFingerprintAsync(projectOverlay(overlay));
        } catch {
          // A policy mismatch is a rejection; a retired publisher still fails closed.
          toolAuthority?.assertActive();
          return undefined;
        }
      },
      resolve: (params) =>
        getSessionControllerEntryForOperation(operation).attachment === attachment &&
        getAttachedBackend(operation) === backend
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
}

function resolveReplyBackendMessageInjection(
  backend: ReplyBackendHandle,
  canInject: () => boolean,
  sourceBound: boolean,
  preparation?: ReplyToolAuthorityPreparation,
): (ReplyBackendMessageInjection & ReturnType<typeof bindMessageInjectionV2>) | undefined {
  const guarded = backend.messageInjectionV2;
  const assertCurrent = createMessageInjectionAuthority(canInject);
  const legacy =
    preparation && !guarded?.queueMessageAsync
      ? createLegacyToolAuthorityQueuePreflight(preparation)
      : undefined;
  if (guarded?.version === 2) {
    return {
      isAvailable: () => guarded.isAvailable(),
      ...bindMessageInjectionV2(
        guarded,
        assertCurrent,
        sourceBound ? "source-bound" : "run",
        preparation && (() => ({ ...preparation, compatAssertCurrent: assertCurrent })),
        legacy,
      ),
    };
  }
  if (sourceBound) {
    assertCurrent();
    return undefined;
  }
  const injection = backend.messageInjection;
  if (!injection && !backend.queueMessage) {
    return undefined;
  }

  return {
    claimPendingUserInputAnswer: backend.claimPendingUserInputAnswer?.bind(backend),
    cancelPendingUserInput: backend.cancelPendingUserInput?.bind(backend),
    prepareQueueMessage: legacy?.prepareQueueMessage,
    isAvailable: () => {
      // Legacy handles already expose the only capability that matters here:
      // queueMessage. Let the runtime accept or reject instead of guessing from
      // unrelated token-stream state.
      return injection ? injection.isAvailable() : !backend.isStopped?.();
    },
    queueMessage: (text, options) => {
      legacy?.assertQueueCurrent();
      assertCurrent();
      if (injection) {
        return injection.queueMessage(text, options);
      }
      return options ? backend.queueMessage!(text, options) : backend.queueMessage!(text);
    },
  };
}

function resolveReplyMessageInjectionRejection(params: {
  operation: ReplyOperation | undefined;
  options?: ReplyBackendQueueMessageOptions;
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
  const backend = getAttachedBackend(operation);
  // Native registration publishes commit capability; the released attachBackend contract
  // delegates transcript waiting to its sink without requiring that observation.
  if (
    attachment &&
    "handle" in attachment &&
    params.options?.waitForTranscriptCommit === true &&
    attachment.handle.supportsTranscriptCommitWait !== true
  ) {
    return { reason: "transcript_commit_wait_unsupported" };
  }
  const toolAuthority =
    attachment && "toolAuthority" in attachment ? attachment.toolAuthority : undefined;
  const canInject = () => {
    if (
      !isCurrentSessionControllerOperation(operation) ||
      operation.result ||
      operationState?.phase !== "running" ||
      getSessionControllerEntryForOperation(operation).attachment !== attachment ||
      getAttachedBackend(operation) !== backend
    ) {
      return false;
    }
    toolAuthority?.assertActive();
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

/** The source and concrete execution owner compose their authority at the same V2 sink. */
function resolveReplyBackendMessageInjectionRejection(params: {
  sessionId: string;
  backend: ReplyBackendHandle | undefined;
  canInject: () => boolean;
  toolAuthorityFingerprint?: string;
  options?: ReplyBackendQueueMessageOptions;
  personalToolParticipant?: ReplyMessageInjectionOptions["personalToolParticipant"];
  personalToolParticipants?: ReplyTurnParticipants;
  allowPendingUserInputAnswer?: false;
  assertCurrent?: () => void;
  preparation?: ReplyToolAuthorityPreparation;
}): ReplyMessageInjectionResolution {
  const { backend } = params;
  const canInject = () => {
    params.preparation?.compatAssertCurrent();
    params.assertCurrent?.();
    return params.canInject();
  };
  const injection = backend
    ? resolveReplyBackendMessageInjection(
        backend,
        canInject,
        params.assertCurrent !== undefined,
        params.preparation && {
          ...params.preparation,
          assertCurrent: createMessageInjectionAuthority(() => {
            params.preparation!.assertCurrent();
            params.assertCurrent?.();
            return params.canInject();
          }),
        },
      )
    : undefined;
  if (!backend || !injection) {
    return {
      reason:
        backend && params.assertCurrent && backend.messageInjectionV2?.version !== 2
          ? "guarded_injection_unsupported"
          : "injection_unavailable",
    };
  }
  try {
    const compactionAllowsSteering = canSteerEmbeddedRunDuringCompaction(params.sessionId, backend);
    if (!injection.isAvailable() || !compactionAllowsSteering) {
      return { reason: "injection_unavailable" };
    }
  } catch (error) {
    return { reason: "injection_unavailable", errorMessage: String(error) };
  }
  if (
    backend.supportsCrossProfileSteering === false &&
    params.options?.isInboundUserMessage === true &&
    params.personalToolParticipant?.operatorAuthority &&
    params.personalToolParticipant.operatorAuthority.profileId !==
      params.personalToolParticipants?.resolve(undefined, { allowTurnOwner: () => true })?.profileId
  ) {
    // Question answers through injection also record participants. Leave another
    // profile's input with followup custody before any question-only bypass.
    return { reason: "tool_authority_mismatch", backend };
  }
  const mismatch = resolveReplyBackendQueueMessageMismatch(backend, params.options, params);
  const activeFingerprint = normalizeOptionalString(
    backend.toolAuthorityFingerprint ?? params.toolAuthorityFingerprint,
  );
  const toolAuthorityMatched =
    activeFingerprint !== undefined &&
    normalizeOptionalString(params.options?.toolAuthorityFingerprint) === activeFingerprint;
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
    (pendingInputAuthorityProven || toolAuthorityMatched);
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
          options?.onQueueAccepted?.(true);
          options?.onQueueSettled?.();
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
    : { backend, injection, prepareQueueMessage: injection.prepareQueueMessage };
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

/** Advisory only; injection still prepares and checks the captured owner at its effect. */
export function canInjectReplyMessageTarget(
  target: ReplyMessageInjectionTarget,
  options?: ReplyMessageInjectionOptions,
): boolean {
  try {
    if (options?.canAdmit?.() === false) {
      return false;
    }
    const owner = target[replyMessageInjectionTargetOwner];
    const {
      toolAuthorityOverlay,
      toolAuthorityPreparation,
      personalToolParticipant,
      assertCurrent,
      allowPendingUserInputAnswer,
      inboundAudio,
      canAdmit: _canAdmit,
      ...backendOptions
    } = options ?? {};
    toolAuthorityPreparation?.compatAssertCurrent();
    assertCurrent?.();
    return (
      "injection" in
      owner.resolve({
        options: {
          ...backendOptions,
          ...(toolAuthorityOverlay
            ? {
                toolAuthorityFingerprint:
                  owner.projectToolAuthorityFingerprint(toolAuthorityOverlay),
              }
            : {}),
        },
        personalToolParticipant: toolAuthorityOverlay ?? personalToolParticipant,
        inboundAudio,
        allowPendingUserInputAnswer,
        assertCurrent,
      })
    );
  } catch {
    return false;
  }
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
  const resolvePreAcceptanceFailure = (error: unknown): ReplyMessageInjectionOutcome => {
    const failure = resolveReplyMessageInjectionFailure(error, {
      assertCurrent: assertSourceCurrent,
      accepted: false,
    });
    if (!failure) {
      throw error;
    }
    return failure;
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
    toolAuthorityOverlay,
    toolAuthorityPreparation,
    personalToolParticipant,
    assertCurrent,
    allowPendingUserInputAnswer,
    inboundAudio,
    ...backendOptions
  } = options ?? {};
  const projectedToolAuthorityFingerprint = toolAuthorityOverlay
    ? await owner.projectToolAuthorityFingerprintAsync(toolAuthorityOverlay)
    : backendOptions.toolAuthorityFingerprint;
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
        ...(toolAuthorityOverlay
          ? { toolAuthorityFingerprint: projectedToolAuthorityFingerprint }
          : {}),
      }
    : undefined;
  const resolved: ReplyMessageInjectionResolution =
    canAdmit?.() === false
      ? { reason: "injection_unavailable" }
      : owner.resolve({
          options: queueOptions,
          personalToolParticipant: toolAuthorityOverlay ?? personalToolParticipant,
          inboundAudio,
          allowPendingUserInputAnswer,
          // An overlay alone does not add a caller lifetime binding to legacy input.
          assertCurrent: sourceBound ? assertSourceCurrent : undefined,
          preparation: toolAuthorityOverlay
            ? bindPreparedToolAuthority(
                bindWorkerToolPreparation(
                  {
                    assertCurrent: () => assertSourceCurrent?.(),
                    compatAssertCurrent: () => {
                      toolAuthorityPreparation?.compatAssertCurrent();
                      const overlay = options?.toolAuthorityOverlay;
                      assertPolicy(overlay && owner.projectToolAuthorityFingerprint(overlay));
                    },
                    prepareCurrent: async () => {
                      await toolAuthorityPreparation?.prepareCurrent();
                      const overlay = options?.toolAuthorityOverlay;
                      assertPolicy(
                        overlay && (await owner.projectToolAuthorityFingerprintAsync(overlay)),
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
    // This caller owns no second queue item. Sharing the receipt leaves FIFO free
    // while the original delivery settles, but never shares caller authority.
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
    // Callers may observe only one receipt; preserve rejection for awaiters
    // without leaking the independently settling projection as unhandled.
    void acceptance.catch(() => {});
    void outcome.catch(() => {});
    return { targetRunId: existing.targetRunId, acceptance, outcome };
  }
  // The backend selected at the final admission check owns steering identity.
  // Durable provenance is confirmed only after this exact queue operation proves
  // transcript commitment; acceptance alone is insufficient.
  // Injection is user input, not run evidence: stamping activity here would let
  // sub-10-minute user messages re-arm a wedged run's staleness window forever.
  // Legacy preflight keeps this FIFO reservation; the capability owns the final
  // synchronous admission check, matching Codex's active-turn lock boundary.
  const acceptance = createDeferredCore<boolean>();
  let acceptanceSettled = false;
  let queueAccepted = false;
  let participantRecorded = false;
  const recordParticipant = () => {
    const participant = toolAuthorityOverlay ?? personalToolParticipant;
    if (!participantRecorded && queueOptions?.isInboundUserMessage && participant) {
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
    // Admission above checks the human principal; the runtime must not interpret
    // an authorized status control as an answer to ask_user.
    ...(allowPendingUserInputAnswer === false
      ? { isInboundUserMessage: false, allowPendingUserInputAnswer }
      : {}),
    onQueueAccepted: (accepted) => {
      // Rejection is provisional until the outcome rules out an uncertain question
      // dispatch. Forwarding false early would release the parked input for replay.
      if (accepted) {
        queueAccepted = true;
        recordParticipant();
        settleAcceptance(true);
      }
    },
  };
  const failed = (error: unknown): ReplyMessageInjectionOutcome => {
    const outcome: ReplyMessageInjectionOutcome = resolveReplyMessageInjectionFailure(error, {
      assertCurrent: assertSourceCurrent,
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
        // Receipt uncertainty retains this input, but cannot authorize canceling
        // the active run or replaying input the runtime may already have consumed.
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
