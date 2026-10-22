import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { canSteerEmbeddedRunDuringCompaction } from "../agents/embedded-agent-runner/runs.probes.js";
import {
  bindMessageInjectionV2,
  createLegacyToolAuthorityQueuePreflight,
} from "../agents/harness/tool-authority-preparation.js";
import { createMessageInjectionAuthority } from "../auto-reply/reply/message-injection-authority.js";
import { hasPromptImageInput } from "../media/prompt-image-input.js";
import {
  replyMessageInjectionTargetOwner,
  type ReplyMessageInjectionTarget,
  type ReplyBackendHandle,
  type ReplyBackendMessageInjection,
  type ReplyBackendQueueMessageOptions,
  type ReplyMessageInjectionOptions,
  type ReplyMessageInjectionResolution,
  type ReplyTurnParticipants,
  type ReplyToolAuthorityPreparation,
} from "./session-controller.contracts.js";
import { resolveReplyBackendQueueMessageMismatch } from "./session-controller.message-injection-failure.js";

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

/** The source and concrete execution owner compose their authority at the same V2 sink. */
export function resolveReplyBackendMessageInjectionRejection(params: {
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
    : {
        backend,
        injection,
        prepareQueueMessage: injection.prepareQueueMessage,
      };
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
      requesterToolAuthority,
      toolAuthorityPreparation,
      personalToolParticipant,
      assertCurrent,
      allowPendingUserInputAnswer,
      inboundAudio,
      canAdmit: _canAdmit,
      allowCollaborativeSteering: _allowCollaborativeSteering,
      ...backendOptions
    } = options ?? {};
    toolAuthorityPreparation?.compatAssertCurrent();
    assertCurrent?.();
    return (
      "injection" in
      owner.resolve({
        options: {
          ...backendOptions,
          ...(requesterToolAuthority || toolAuthorityOverlay
            ? {
                toolAuthorityFingerprint: requesterToolAuthority
                  ? owner.projectRequesterToolAuthorityFingerprint(requesterToolAuthority)
                  : toolAuthorityOverlay &&
                    owner.projectToolAuthorityFingerprint(toolAuthorityOverlay),
              }
            : {}),
        },
        requesterToolAuthority,
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
