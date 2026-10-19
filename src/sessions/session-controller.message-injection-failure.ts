import {
  collectErrorGraphCandidates,
  readErrorCauses,
  toErrorObject,
} from "@openclaw/normalization-core/error-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  QuestionAnswerUnconfirmedError,
  QuestionDispatchRefusedError,
  QuestionDispatchUnsupportedError,
} from "../agents/harness/gateway-question-dispatch.js";
import {
  MessageInjectionAcceptedUnconfirmedError,
  MessageInjectionAuthorityError,
  MessageInjectionTargetUnavailableError,
  MessageInjectionWithdrawnError,
} from "../auto-reply/reply/message-injection-authority.js";
import { SessionPendingInputCustodyError } from "../config/sessions/session-pending-input-custody-error.js";
import { getAgentRunContext } from "../infra/agent-run-registry.js";
import { hasPromptImageInput } from "../media/prompt-image-input.js";
import type {
  ReplyBackendHandle,
  ReplyBackendQueueMessageMismatch,
  ReplyBackendQueueMessageOptions,
  ReplyMessageInjectionOutcome,
} from "./session-controller.contracts.js";

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

export function resolveReplyMessageInjectionFailure(
  error: unknown,
  params: { assertCurrent?: () => void; accepted: boolean },
): ReplyMessageInjectionOutcome | undefined {
  const { assertCurrent, accepted } = params;
  const candidates = collectErrorGraphCandidates(error, readErrorCauses);
  const unsupported = candidates.findLast(
    (candidate) => candidate instanceof QuestionDispatchUnsupportedError,
  );
  const unconfirmed = candidates.findLast(
    (candidate) =>
      candidate instanceof QuestionAnswerUnconfirmedError ||
      candidate instanceof MessageInjectionAcceptedUnconfirmedError,
  );
  if (unconfirmed) {
    return { status: "indeterminate", errorMessage: unconfirmed.message };
  }
  if (
    accepted &&
    !candidates.some((candidate) => candidate instanceof MessageInjectionWithdrawnError)
  ) {
    const sourceRefusal = candidates.findLast(
      (candidate) => candidate instanceof MessageInjectionAuthorityError,
    );
    const completionError = sourceRefusal?.cause instanceof Error ? sourceRefusal.cause : error;
    return {
      status: "indeterminate",
      errorMessage: toErrorObject(completionError, "Message injection completion failed").message,
    };
  }
  const rejectUnavailable = (): ReplyMessageInjectionOutcome => {
    try {
      assertCurrent?.();
    } catch (sourceError) {
      return {
        status: "failed",
        error: toErrorObject(sourceError, "Message source authority is no longer current"),
      };
    }
    return { status: "rejected", reason: "injection_unavailable" };
  };
  const targetUnavailable = candidates.findLast(
    (candidate) => candidate instanceof MessageInjectionTargetUnavailableError,
  );
  if (targetUnavailable) {
    return rejectUnavailable();
  }
  const refusal = candidates.findLast(
    (candidate) =>
      candidate instanceof MessageInjectionAuthorityError ||
      ((assertCurrent !== undefined || unsupported !== undefined) &&
        ((candidate instanceof QuestionDispatchRefusedError &&
          !(candidate instanceof QuestionDispatchUnsupportedError)) ||
          candidate instanceof SessionPendingInputCustodyError)),
  );
  if (unsupported && !refusal) {
    return rejectUnavailable();
  }
  const authorityError = refusal ?? unsupported;
  if (authorityError instanceof Error) {
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
