import { expectDefined } from "@openclaw/normalization-core";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  buildOAuthRefreshFailureLoginCommand,
  classifyOAuthRefreshFailure,
  classifyOAuthRefreshFailureError,
  formatOAuthRefreshFailureLoginCommandMarkdown,
} from "../../agents/auth-profiles/oauth-refresh-failure.js";
import { sanitizeUserFacingText } from "../../agents/embedded-agent-helpers/sanitize-user-facing-text.js";
import {
  renderAgentHarnessPreflightUserMessage,
  renderUserFacingText,
} from "../../agents/embedded-agent-helpers/user-facing-text.js";
import { classifyCompactionReason } from "../../agents/embedded-agent-runner/compact-reasons.js";
import {
  findCliTerminalStopError,
  findCliTimeoutError,
  hasLocalWorkerTaskTimeout,
  isFailoverError,
  isNonProviderRuntimeCoordinationError,
} from "../../agents/failover-error.js";
import {
  renderAssistantRequestFailureCopy,
  renderRuntimeCoordinationFailureCopy,
} from "../../agents/failover/assistant-request-failure-copy.js";
import { resolveExecutionApprovalFailureMessage } from "../../agents/failover/message-patterns.js";
import { resolveReplyFailoverFacts } from "../../agents/failover/request-error-facts.js";
import {
  GENERIC_EXTERNAL_RUN_FAILURE_TEXT,
  HEARTBEAT_EXTERNAL_RUN_FAILURE_TEXT,
  renderAuthProfileFailoverCopy,
  renderBillingReplyCopy,
  renderCliTimeoutReplyCopy,
  renderCodexAppServerFailureCopy,
  renderFailoverCodeUserCopy,
  renderHeartbeatRunFailureCopy,
  renderMissingApiKeyReplyCopy,
  renderRateLimitOrOverloadedCopy,
  renderRateLimitReplyCopy,
  type ReplyFallbackAttempt,
} from "../../agents/failover/user-copy.js";
import { isAgentHarnessPreflightError } from "../../agents/harness/errors.js";
import { isProviderAuthError } from "../../agents/model-auth-runtime-shared.js";
import { buildProviderAuthRecoveryHint } from "../../agents/provider-auth-recovery-hint.js";
import type { ReplyCompletion, ReplyExpectation } from "../../agents/reply-completion.js";
import {
  collectErrorGraphCandidates,
  formatErrorMessage,
  readErrorCauses,
} from "../../infra/errors.js";
import { SkillResourceDeliveryLimitError } from "../../skills/runtime/resource-delivery-error.js";
import { buildProviderLoginRecovery } from "../provider-login-recovery.js";
import {
  copyReplyPayloadMetadata,
  getReplyPayloadMetadata,
  isReplyPayloadTerminalContent,
  markReplyPayloadForSourceSuppressionDelivery,
  setReplyPayloadMetadata,
} from "../reply-payload.js";
import type { TemplateContext } from "../templating.js";
import type { VerboseLevel } from "../thinking.js";
import { isSilentReplyText, SILENT_REPLY_TOKEN } from "../tokens.js";
import type { ReplyPayload } from "../types.js";

type ReplyFailoverFacts = ReturnType<typeof resolveReplyFailoverFacts>;

function readFallbackAttempts(error: unknown): readonly ReplyFallbackAttempt[] {
  return isFailoverError(error) && Array.isArray(error.attempts) ? error.attempts : [];
}

export function resolveReplyFailureSummary(params: {
  error: unknown;
  message: string;
  reason: ReplyFailoverFacts["reason"];
  attempts?: readonly ReplyFallbackAttempt[];
}): { kind: "billing" | "rate_limit" | "overloaded"; text: string } | undefined {
  const attempts = params.attempts;
  let kind = params.reason;
  // The top-level reason describes the last attempt; aggregate copy must account for the entire chain.
  if (attempts?.length) {
    if (attempts.some((attempt) => attempt.reason === "billing")) {
      kind = "billing";
    } else if (attempts.every((attempt) => attempt.reason === "overloaded")) {
      kind = "overloaded";
    } else {
      kind = attempts.every(
        (attempt) => attempt.reason === "rate_limit" || attempt.reason === "overloaded",
      )
        ? "rate_limit"
        : undefined;
    }
  }
  if (kind !== "billing" && kind !== "rate_limit" && kind !== "overloaded") {
    return undefined;
  }
  const failoverError = isFailoverError(params.error) ? params.error : undefined;
  const text =
    kind === "billing"
      ? renderBillingReplyCopy({
          attempts,
          provider: failoverError?.provider,
          model: failoverError?.model,
          authMode: failoverError?.authMode,
        })
      : kind === "overloaded"
        ? renderRateLimitOrOverloadedCopy({ reason: kind, raw: params.message })
        : renderRateLimitReplyCopy({
            message: params.message,
            reason: params.reason,
            attempts,
            provider: failoverError?.provider,
            cooldownExpiry: failoverError?.soonestCooldownExpiry,
            sanitizeText: (rawText) => sanitizeUserFacingText(rawText, { errorContext: true }),
          });
  return { kind, text };
}

function collapseRepeatedFailureDetail(message: string): string {
  const parts = message
    .split(/\s+\|\s+/u)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length >= 2 && parts.every((part) => part === parts[0])) {
    return expectDefined(parts[0], "parts entry at 0");
  }
  return message.trim();
}

const EXTERNAL_RUN_FAILURE_DETAIL_MAX_CHARS = 900;
const PREFLIGHT_COMPACTION_FAILURE_PREFIX = "Preflight compaction required but failed:";
// The refresh fence/observer owns this deadline message; failover's timeout family also includes DNS/transport failures.
const OAUTH_REFRESH_HARD_TIMEOUT_RE =
  /(?:^|:\s)OAuth refresh call "[^"\r\n]+" exceeded hard timeout \(\d+ms\)$/u;

type ExternalRunFailureReply = Pick<ReplyPayload, "text" | "presentation"> & {
  text: string;
  isGenericRunnerFailure: boolean;
};

type ExternalRunFailureInput = string | { message: string; error?: unknown };

type ExternalFailureConversationContext = Pick<
  TemplateContext,
  "ChatType" | "Provider" | "SessionKey" | "Surface"
>;

export function isNonDirectConversationContext(ctx: ExternalFailureConversationContext): boolean {
  const chatType = normalizeLowercaseStringOrEmpty(ctx.ChatType);
  return chatType === "group" || chatType === "channel";
}

export function isVerboseFailureDetailEnabled(level: VerboseLevel | undefined): boolean {
  return level === "on" || level === "full";
}

export function buildPreflightCompactionFailureText(
  message: string,
  options?: { includeDetails?: boolean },
): string | null {
  const normalizedMessage = collapseRepeatedFailureDetail(message);
  if (!normalizedMessage.startsWith(PREFLIGHT_COMPACTION_FAILURE_PREFIX)) {
    return null;
  }
  const reason = renderUserFacingText(
    normalizedMessage.slice(PREFLIGHT_COMPACTION_FAILURE_PREFIX.length),
    { errorContext: true },
  )
    .trim()
    .replace(/\s+/gu, " ");
  const isTimeout = classifyCompactionReason(reason) === "timeout";
  const reasonSuffix = options?.includeDetails && reason && !isTimeout ? ` Reason: ${reason}.` : "";
  const summary = isTimeout
    ? "⚠️ This conversation is too long, and shortening it took too long."
    : "⚠️ This conversation is too long, and OpenClaw couldn't shorten it.";
  return `${summary}${reasonSuffix} Try again, use /compact, or use /new to start a fresh session.`;
}

export function buildAuthProfileFailoverFailureText(error: unknown): string | null {
  if (!isFailoverError(error) || !error.provider || !error.authProfileFailure) {
    return null;
  }
  return renderAuthProfileFailoverCopy({
    reason: error.reason,
    provider: error.provider,
    allInCooldown: error.authProfileFailure.allInCooldown,
    recoveryHint: buildProviderAuthRecoveryHint({ provider: error.provider }),
  });
}

function resolveExternalRunFailureDetail(message: string): string | undefined {
  const sanitized = message
    .trim()
    .replace(/^⚠️\s*/u, "")
    .replace(/\s+/gu, " ");
  return sanitized.length > EXTERNAL_RUN_FAILURE_DETAIL_MAX_CHARS
    ? `${truncateUtf16Safe(sanitized, EXTERNAL_RUN_FAILURE_DETAIL_MAX_CHARS - 1).trimEnd()}…`
    : sanitized || undefined;
}

function formatForwardedExternalRunFailureText(message: string): string {
  const detail = resolveExternalRunFailureDetail(message);
  return detail
    ? `⚠️ Agent failed before reply: ${detail}${/[.!?]$/u.test(detail) ? "" : "."} Please try again, or use /new to start a fresh session.`
    : GENERIC_EXTERNAL_RUN_FAILURE_TEXT;
}

export function buildExternalRunFailureReply(
  input: ExternalRunFailureInput,
  options?: {
    includeAuthProfileId?: boolean;
    includeDetails?: boolean;
    isHeartbeat?: boolean;
    /** Wording only; heartbeat visibility/suppression semantics stay on isHeartbeat. */
    useHeartbeatFailureCopy?: boolean;
    replayPrevented?: boolean;
    failoverFacts?: ReplyFailoverFacts;
  },
): ExternalRunFailureReply {
  const message = typeof input === "string" ? input : input.message;
  const error = typeof input === "string" ? undefined : input.error;
  const normalizedMessage = collapseRepeatedFailureDetail(message);
  const useHeartbeatFailureCopy = options?.useHeartbeatFailureCopy ?? options?.isHeartbeat === true;
  const buildUnclassifiedReply = (includeHeartbeatDetails: boolean): ExternalRunFailureReply => {
    const sanitizedMessage = sanitizeUserFacingText(normalizedMessage, { errorContext: true });
    return {
      text: useHeartbeatFailureCopy
        ? renderHeartbeatRunFailureCopy(
            includeHeartbeatDetails ? resolveExternalRunFailureDetail(sanitizedMessage) : undefined,
          )
        : options?.includeDetails
          ? formatForwardedExternalRunFailureText(sanitizedMessage)
          : GENERIC_EXTERNAL_RUN_FAILURE_TEXT,
      isGenericRunnerFailure: !options?.isHeartbeat,
    };
  };
  const approvalMessage = resolveExecutionApprovalFailureMessage(normalizedMessage);
  if (approvalMessage) {
    return { text: `⚠️ ${approvalMessage}`, isGenericRunnerFailure: false };
  }
  if (
    collectErrorGraphCandidates(error, readErrorCauses).some(
      (candidate) => candidate instanceof SkillResourceDeliveryLimitError,
    )
  ) {
    return {
      text: "⚠️ Selected skill resources exceed the 8 MiB delivery limit. Select fewer skills, then try again.",
      isGenericRunnerFailure: false,
    };
  }
  // A preflight refusal is host-authored and names the next step. Heartbeats run
  // unattended in the owner's session, so they disclose it without the verbose
  // opt-in; raw thrown detail further below stays verbose-gated.
  if (isAgentHarnessPreflightError(error)) {
    const userMessage = renderAgentHarnessPreflightUserMessage(error);
    if (userMessage !== undefined) {
      return {
        text: userMessage,
        isGenericRunnerFailure: false,
      };
    }
    return buildUnclassifiedReply(true);
  }
  const failoverFacts =
    options?.failoverFacts ??
    resolveReplyFailoverFacts(error ?? normalizedMessage, normalizedMessage);
  const failoverCodeCopy = renderFailoverCodeUserCopy(failoverFacts.code);
  if (failoverCodeCopy) {
    return { text: failoverCodeCopy, isGenericRunnerFailure: false };
  }
  const runtimeCoordinationFailure =
    failoverFacts.code && isNonProviderRuntimeCoordinationError(error)
      ? renderRuntimeCoordinationFailureCopy(failoverFacts.code)
      : undefined;
  if (runtimeCoordinationFailure) {
    return { text: runtimeCoordinationFailure, isGenericRunnerFailure: false };
  }
  const oauthRefreshFailure =
    classifyOAuthRefreshFailureError(error) ?? classifyOAuthRefreshFailure(normalizedMessage);
  const providerLoginRecovery = buildProviderLoginRecovery({
    provider: oauthRefreshFailure
      ? (oauthRefreshFailure.provider ?? undefined)
      : failoverFacts.provider,
    oauthReason: oauthRefreshFailure?.reason,
    failoverReason: failoverFacts.reason,
    authMode: failoverFacts.authMode,
  });
  if (oauthRefreshFailure) {
    const attempts = readFallbackAttempts(error);
    const primaryAttempt = attempts.length > 1 ? attempts[0] : undefined;
    // Attempt diagnostics remain verbose-gated; the chain exposes only classified copy.
    const primaryCopy = primaryAttempt
      ? (renderAssistantRequestFailureCopy({ reason: primaryAttempt.reason }) ??
        "OpenClaw couldn't finish this reply.")
      : undefined;
    const fallbackContext = primaryCopy
      ? `Primary attempt failed: ${primaryCopy.replace(/^⚠️\s*/u, "")} ${attempts.length > 2 ? `${attempts.length - 1} fallback attempts failed. Last fallback: ` : "Fallback: "}`
      : "";
    const lastAttempt = attempts.at(-1);
    if (
      primaryAttempt &&
      !oauthRefreshFailure.reason &&
      lastAttempt?.provider === oauthRefreshFailure.provider &&
      lastAttempt?.error &&
      OAUTH_REFRESH_HARD_TIMEOUT_RE.test(lastAttempt.error)
    ) {
      const providerText = oauthRefreshFailure.provider
        ? ` for ${oauthRefreshFailure.provider}`
        : "";
      return {
        text: `⚠️ ${fallbackContext}Login refresh${providerText} timed out. Please try again. For details, open Settings → Logs in the Control UI or run \`openclaw logs --follow\`.`,
        isGenericRunnerFailure: false,
      };
    }
    const loginCommand = buildOAuthRefreshFailureLoginCommand(oauthRefreshFailure.provider, {
      profileId: options?.includeAuthProfileId ? oauthRefreshFailure.profileId : undefined,
    });
    const loginCommandMarkdown = formatOAuthRefreshFailureLoginCommandMarkdown(loginCommand);
    const providerText = oauthRefreshFailure.provider ? ` for ${oauthRefreshFailure.provider}` : "";
    const retryLoginHint = providerLoginRecovery
      ? "send `/login` from a private chat or Control UI session to choose a provider, or re-auth"
      : "re-auth";
    if (oauthRefreshFailure.reason) {
      return {
        text: providerLoginRecovery
          ? `⚠️ ${fallbackContext}${providerLoginRecovery.hint} You can also re-auth with ${loginCommandMarkdown} on the gateway.`
          : `⚠️ ${fallbackContext}Model login expired on the gateway${providerText}. Re-auth with ${loginCommandMarkdown} in a terminal, then try again.`,
        ...(providerLoginRecovery ? { presentation: providerLoginRecovery.presentation } : {}),
        isGenericRunnerFailure: false,
      };
    }
    return {
      text: `⚠️ ${fallbackContext}Model login failed on the gateway${providerText}. Please try again. If this keeps happening, ${retryLoginHint} with ${loginCommandMarkdown} in a terminal.`,
      isGenericRunnerFailure: false,
    };
  }
  const authProfileFailoverFailure = buildAuthProfileFailoverFailureText(error);
  if (authProfileFailoverFailure) {
    return {
      text: providerLoginRecovery
        ? `${providerLoginRecovery.hint}\n\n${authProfileFailoverFailure}`
        : authProfileFailoverFailure,
      ...(providerLoginRecovery ? { presentation: providerLoginRecovery.presentation } : {}),
      isGenericRunnerFailure: false,
    };
  }
  const cliTerminalStopError = findCliTerminalStopError(error);
  if (cliTerminalStopError) {
    return {
      text: renderUserFacingText(cliTerminalStopError.message, { errorContext: true }),
      isGenericRunnerFailure: false,
    };
  }
  const cliTimeoutError = findCliTimeoutError(error);
  const cliBackendTimeoutFailure = renderCliTimeoutReplyCopy({
    message: normalizedMessage,
    cliTimeout: cliTimeoutError?.cliTimeout,
    provider: cliTimeoutError?.provider,
    replayPrevented: options?.replayPrevented,
  });
  if (cliBackendTimeoutFailure) {
    return { text: cliBackendTimeoutFailure, isGenericRunnerFailure: false };
  }
  const providerRequestError = failoverFacts.providerRequestError;
  if (providerRequestError) {
    // Curated facet copy carries recovery guidance (quota/billing ambiguity,
    // /new for conversation-state, config fix for model_not_found); the
    // classified summary below is the fallback for facts without a facet.
    return { text: providerRequestError.userMessage, isGenericRunnerFailure: false };
  }
  const authError = isProviderAuthError(error) ? error : undefined;
  const missingApiKeyFailure = renderMissingApiKeyReplyCopy(
    authError
      ? { provider: authError.provider, providerGuidance: authError.providerGuidance }
      : undefined,
  );
  if (missingApiKeyFailure) {
    return { text: missingApiKeyFailure, isGenericRunnerFailure: false };
  }
  if (options?.isHeartbeat) {
    // Heartbeat-backed event turns remain visible even with generic wording.
    return buildUnclassifiedReply(options.includeDetails === true);
  }
  const codexAppServerFailure = renderCodexAppServerFailureCopy(normalizedMessage);
  if (codexAppServerFailure) {
    return { text: codexAppServerFailure, isGenericRunnerFailure: false };
  }
  if (failoverFacts.reason === "timeout" && hasLocalWorkerTaskTimeout(error)) {
    return {
      text: "A local worker task timed out. Please try again.",
      isGenericRunnerFailure: false,
    };
  }
  const classifiedFailure =
    failoverFacts.requestFailureText ?? renderAssistantRequestFailureCopy(failoverFacts);
  if (classifiedFailure) {
    return { text: classifiedFailure, isGenericRunnerFailure: false };
  }
  // Only unclassified thrown text reaches this branch. Verbose mode is the
  // explicit opt-in because sanitization does not make raw provider bodies safe.
  return {
    text: options?.includeDetails
      ? formatForwardedExternalRunFailureText(
          renderUserFacingText(normalizedMessage, { errorContext: true }),
        )
      : GENERIC_EXTERNAL_RUN_FAILURE_TEXT,
    isGenericRunnerFailure: true,
  };
}

export function markAgentRunFailureReplyPayload<T extends ReplyPayload>(payload: T): T {
  const marked = markReplyPayloadForSourceSuppressionDelivery(payload);
  if (!isSilentReplyText(marked.text, SILENT_REPLY_TOKEN)) {
    marked.isError = true;
  }
  return marked;
}

export function markPostCompactionModelFailurePayload(
  postCompactionModelFailure: true | undefined,
  payload: ReplyPayload,
): ReplyPayload {
  return postCompactionModelFailure === true &&
    payload.isError === true &&
    isReplyPayloadTerminalContent(payload) &&
    typeof payload.text === "string"
    ? setReplyPayloadMetadata(payload, { postCompactionModelFailure: true })
    : payload;
}

export function renderPostCompactionModelFailurePayload(payload: ReplyPayload): ReplyPayload {
  return getReplyPayloadMetadata(payload)?.postCompactionModelFailure === true &&
    typeof payload.text === "string"
    ? copyReplyPayloadMetadata(payload, {
        ...payload,
        text: `⚠️ Context compaction succeeded, but the later model request still failed. ${payload.text.replace(/^⚠️\s*/u, "")}`,
      })
    : payload;
}

/** Optional silence hides generic boilerplate, not guidance or the outcome of visible work. */
export function resolveAgentRunFailureText(params: {
  text: string;
  replyExpectation: ReplyExpectation;
  isGenericRunnerFailure: boolean;
  visibleReplyDelivered: boolean;
}): string {
  return params.replyExpectation === "optional" &&
    params.isGenericRunnerFailure &&
    !params.visibleReplyDelivered
    ? SILENT_REPLY_TOKEN
    : params.text;
}

export function buildTerminalAgentRunFailureReplyPayload(params: {
  isHeartbeat?: boolean;
  useHeartbeatFailureCopy?: boolean;
  replyExpectation: ReplyExpectation;
  visibleReplyDelivered: boolean;
}): ReplyPayload {
  const useHeartbeatFailureCopy = params.useHeartbeatFailureCopy ?? params.isHeartbeat === true;
  return markAgentRunFailureReplyPayload({
    text: resolveAgentRunFailureText({
      ...params,
      text: useHeartbeatFailureCopy
        ? HEARTBEAT_EXTERNAL_RUN_FAILURE_TEXT
        : GENERIC_EXTERNAL_RUN_FAILURE_TEXT,
      // Visibility follows the execution surface, not which sentence we render.
      isGenericRunnerFailure: !params.isHeartbeat,
    }),
  });
}

export function buildEmptyInteractiveReplyPayload(params: {
  completion: ReplyCompletion;
}): ReplyPayload | undefined {
  if (params.completion.outcome !== "missing") {
    return undefined;
  }
  return markAgentRunFailureReplyPayload({
    text: "I finished the turn, but it did not produce a visible reply. Please try again, or start a new session if this keeps happening.",
  });
}

export function buildKnownAgentRunFailureReplyPayload(params: {
  err: unknown;
  sessionCtx: TemplateContext;
  resolvedVerboseLevel: VerboseLevel | undefined;
}): ReplyPayload | undefined {
  // Preflight diagnostics are not provider failures. Only explicit public copy
  // can bypass the caller's diagnostic disclosure policy.
  if (isAgentHarnessPreflightError(params.err)) {
    const reply = buildExternalRunFailureReply({
      message: params.err.message,
      error: params.err,
    });
    return reply.isGenericRunnerFailure
      ? undefined
      : markAgentRunFailureReplyPayload({ text: reply.text });
  }
  const message = formatErrorMessage(params.err);
  const failoverFacts = resolveReplyFailoverFacts(params.err, message);
  const failureSummary = resolveReplyFailureSummary({
    error: params.err,
    message,
    reason: failoverFacts.reason,
    attempts: readFallbackAttempts(params.err),
  });
  const knownFailureText =
    failureSummary?.kind === "billing"
      ? failureSummary.text
      : (buildPreflightCompactionFailureText(message, {
          includeDetails: isVerboseFailureDetailEnabled(params.resolvedVerboseLevel),
        }) ?? failureSummary?.text);
  const externalRunFailureReply: ExternalRunFailureReply = knownFailureText
    ? { text: knownFailureText, isGenericRunnerFailure: false }
    : buildExternalRunFailureReply(
        { message, error: params.err },
        {
          includeAuthProfileId: !isNonDirectConversationContext(params.sessionCtx),
          includeDetails: isVerboseFailureDetailEnabled(params.resolvedVerboseLevel),
          failoverFacts,
        },
      );
  if (externalRunFailureReply.isGenericRunnerFailure) {
    return undefined;
  }
  return markAgentRunFailureReplyPayload({
    text: externalRunFailureReply.text,
    ...(externalRunFailureReply.presentation
      ? { presentation: externalRunFailureReply.presentation }
      : {}),
  });
}
