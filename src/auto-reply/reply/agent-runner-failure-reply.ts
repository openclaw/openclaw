import { expectDefined } from "@openclaw/normalization-core";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  buildOAuthRefreshFailureLoginCommand,
  classifyOAuthRefreshFailure,
  classifyOAuthRefreshFailureError,
} from "../../agents/auth-profiles/oauth-refresh-failure.js";
import { CliCredentialRemovedError } from "../../agents/cli-runner/auth-profile-preparation-error.js";
import { sanitizeUserFacingText } from "../../agents/embedded-agent-helpers/sanitize-user-facing-text.js";
import {
  renderAgentHarnessPreflightUserMessage,
  renderUserFacingText,
} from "../../agents/embedded-agent-helpers/user-facing-text.js";
import { classifyCompactionReason } from "../../agents/embedded-agent-runner/compact-reasons.js";
import type { EmbeddedAgentRunResult } from "../../agents/embedded-agent-runner/types.js";
import {
  FailoverError,
  findCliTerminalStopError,
  findCliTimeoutError,
  isFailoverError,
  isNonProviderRuntimeCoordinationError,
} from "../../agents/failover-error.js";
import {
  renderAssistantRequestFailureCopy,
  renderRuntimeCoordinationFailureCopy,
} from "../../agents/failover/assistant-request-failure-copy.js";
import { AUTH_PROFILE_COOLDOWN_ERROR_CODE } from "../../agents/failover/error.js";
import {
  ContextPreparationTimeoutError,
  findLocalWorkerTaskFailure,
} from "../../agents/failover/local-preparation-error.js";
import { resolveExecutionApprovalFailureMessage } from "../../agents/failover/message-patterns.js";
import { resolveReplyFailoverFacts } from "../../agents/failover/request-error-facts.js";
import {
  GENERIC_EXTERNAL_RUN_FAILURE_TEXT,
  renderAuthProfileFailoverCopy,
  renderBillingReplyCopy,
  renderCliTimeoutReplyCopy,
  renderCodexAppServerFailureCopy,
  renderControlUiAgentFailureCopy,
  renderFailoverCodeUserCopy,
  renderMissingApiKeyReplyCopy,
  renderRateLimitOrOverloadedCopy,
  renderRateLimitReplyCopy,
  type ReplyFallbackAttempt,
} from "../../agents/failover/user-copy.js";
import { isAgentHarnessPreflightError } from "../../agents/harness/errors.js";
import { isProviderAuthError } from "../../agents/model-auth-runtime-shared.js";
import {
  createMissingReplyNotice,
  MISSING_REPLY_NOTICE_TEXT,
  resolveReplyExpectation,
  shouldDeliverMissingReplyNotice,
  type ReplyExpectation,
} from "../../agents/reply-completion.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  collectErrorGraphCandidates,
  formatErrorMessage,
  readErrorCauses,
} from "../../infra/errors.js";
import { readProviderAuthFailure } from "../../plugins/provider-auth-failure.js";
import { isProviderRefusalNoticeText } from "../../shared/assistant-error-format.js";
import { formatInlineCodeSpan } from "../../shared/markdown-code.js";
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
import type { ReplyPayload } from "../types.js";

type ReplyFailoverFacts = ReturnType<typeof resolveReplyFailoverFacts>;

function readFallbackAttempts(error: unknown): readonly ReplyFallbackAttempt[] {
  return isFailoverError(error) && Array.isArray(error.attempts) ? error.attempts : [];
}

export function resolveReplyFailureSummary(params: {
  error: unknown;
  message: string;
  facts: ReplyFailoverFacts;
  attempts?: readonly ReplyFallbackAttempt[];
  config?: OpenClawConfig;
}): { kind: "billing" | "rate_limit" | "overloaded"; text: string } | undefined {
  const attempts = params.attempts;
  let kind = params.facts.reason;
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
  const code = failoverError?.code ?? attempts?.at(-1)?.code;
  const facts = params.facts;
  const text =
    kind === "rate_limit" && !attempts?.length && facts.requestFailureText
      ? facts.requestFailureText
      : kind === "billing"
        ? renderBillingReplyCopy({
            attempts,
            provider: failoverError?.provider,
            model: failoverError?.model,
            authMode: failoverError?.authMode,
          })
        : kind === "overloaded"
          ? // A host-authored refusal names its own cause; overload copy would blame the AI service.
            (code !== AUTH_PROFILE_COOLDOWN_ERROR_CODE && renderFailoverCodeUserCopy(code)) ||
            renderRateLimitOrOverloadedCopy({ reason: kind, raw: params.message })
          : renderRateLimitReplyCopy({
              message: params.message,
              reason: facts.reason,
              attempts,
              provider: failoverError?.provider,
              code: failoverError?.code,
              rateLimitRetriesExhausted: failoverError?.rateLimitRetriesExhausted,
              cooldownExpiry: failoverError?.soonestCooldownExpiry,
              rateLimitResetAt: facts.rateLimitResetAt,
              model: failoverError?.model,
              locale: params.config?.ui?.prefs?.locale,
              timeZone: params.config?.agents?.defaults?.userTimezone,
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

type ExternalRunFailureReply = Pick<ReplyPayload, "text" | "presentation"> & {
  text: string;
  isGenericRunnerFailure: boolean;
  summaryAsTitle?: true;
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
  const classification = classifyCompactionReason(reason);
  if (classification === "unshrinkable_request") {
    return `⚠️ ${reason}`;
  }
  const isTimeout = classification === "timeout";
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
    // Chat reply: the app or `/login` recovers it, never a terminal command.
    recoveryHint: "Open Models in the OpenClaw app to sign in again or choose another login.",
  });
}

function formatForwardedExternalRunFailureText(message: string): string {
  const sanitized = message
    .trim()
    .replace(/^⚠️\s*/u, "")
    .replace(/\s+/gu, " ");
  const detail =
    sanitized.length > EXTERNAL_RUN_FAILURE_DETAIL_MAX_CHARS
      ? `${truncateUtf16Safe(sanitized, EXTERNAL_RUN_FAILURE_DETAIL_MAX_CHARS - 1).trimEnd()}…`
      : sanitized || undefined;
  return detail
    ? `⚠️ Agent failed before reply: ${detail}${/[.!?]$/u.test(detail) ? "" : "."} Please try again, or use /new to start a fresh session.`
    : GENERIC_EXTERNAL_RUN_FAILURE_TEXT;
}

export function buildExternalRunFailureReply(
  input: ExternalRunFailureInput,
  options?: {
    includeAuthProfileId?: boolean;
    includeDetails?: boolean;
    replayPrevented?: boolean;
    failoverFacts?: ReplyFailoverFacts;
    failureSummary?: ReturnType<typeof resolveReplyFailureSummary>;
    shouldSurfaceToControlUi?: boolean;
  },
): ExternalRunFailureReply {
  const message = typeof input === "string" ? input : input.message;
  const error = typeof input === "string" ? undefined : input.error;
  const normalizedMessage = collapseRepeatedFailureDetail(message);
  const removedCredential = collectErrorGraphCandidates(error, readErrorCauses).find(
    (candidate) => candidate instanceof CliCredentialRemovedError,
  );
  if (removedCredential) {
    return {
      text: `⚠️ ${removedCredential.userMessage(options?.includeAuthProfileId)}`,
      isGenericRunnerFailure: false,
    };
  }
  // A typed sign-in failure names its own recovery; chat never shows a terminal command.
  const providerAuthFailure = readProviderAuthFailure(error);
  if (providerAuthFailure) {
    const recovery = buildProviderLoginRecovery({
      provider: isProviderAuthError(error)
        ? error.provider
        : (options?.failoverFacts ?? resolveReplyFailoverFacts(error, normalizedMessage)).provider,
      providerAuthFailure,
    });
    const next = recovery
      ? recovery.hint
      : {
          wait: "Please try again in a few minutes.",
          admin: "Ask your administrator to allow this account.",
          other: "Open Models in the OpenClaw app to check the connection.",
        }[
          providerAuthFailure.recovery === "wait" || providerAuthFailure.recovery === "admin"
            ? providerAuthFailure.recovery
            : "other"
        ];
    return {
      text: `⚠️ ${providerAuthFailure.message} ${next}`,
      ...(recovery ? { presentation: recovery.presentation } : {}),
      isGenericRunnerFailure: false,
    };
  }
  const buildUnclassifiedReply = (): ExternalRunFailureReply => {
    const sanitizedMessage = sanitizeUserFacingText(normalizedMessage, { errorContext: true });
    return {
      text: options?.shouldSurfaceToControlUi
        ? renderControlUiAgentFailureCopy()
        : options?.includeDetails
          ? formatForwardedExternalRunFailureText(sanitizedMessage)
          : GENERIC_EXTERNAL_RUN_FAILURE_TEXT,
      isGenericRunnerFailure: true,
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
  // A preflight refusal is host-authored and names the next step;
  // raw thrown detail further below stays verbose-gated.
  if (isAgentHarnessPreflightError(error)) {
    const userMessage = renderAgentHarnessPreflightUserMessage(error);
    if (userMessage !== undefined) {
      return {
        text: userMessage,
        isGenericRunnerFailure: false,
      };
    }
    return buildUnclassifiedReply();
  }
  const localFailure = findLocalWorkerTaskFailure(error);
  if (localFailure) {
    return {
      text:
        localFailure.code === "overloaded"
          ? "OpenClaw's local workers are at capacity. Check the conversation for completed work before trying again."
          : localFailure instanceof ContextPreparationTimeoutError
            ? localFailure.message
            : "A local worker task timed out. Please try again.",
      isGenericRunnerFailure: false,
    };
  }
  const failoverFacts =
    options?.failoverFacts ??
    resolveReplyFailoverFacts(error ?? normalizedMessage, normalizedMessage);
  const failoverCodeCopy =
    options?.failureSummary?.kind !== "billing" && failoverFacts.rateLimitResetAt === undefined
      ? renderFailoverCodeUserCopy(failoverFacts.code)
      : undefined;
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
    // A reason means the sign-in was refused; without one the refresh may succeed on retry.
    if (oauthRefreshFailure.reason && providerLoginRecovery) {
      return {
        text: `⚠️ ${providerLoginRecovery.hint}`,
        presentation: providerLoginRecovery.presentation,
        isGenericRunnerFailure: false,
      };
    }
    const providerText = oauthRefreshFailure.provider ? ` for ${oauthRefreshFailure.provider}` : "";
    const loginCommand = buildOAuthRefreshFailureLoginCommand(oauthRefreshFailure.provider, {
      surface: "chat",
    });
    return {
      text: `⚠️ Model login failed on the gateway${providerText}. Please try again. If this keeps happening, send ${formatInlineCodeSpan(loginCommand)} from a private chat or the OpenClaw app.`,
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
  if (
    (isFailoverError(error) && error.rateLimitRetriesExhausted !== undefined) ||
    failoverFacts.rateLimitResetAt !== undefined
  ) {
    const summary =
      options?.failureSummary ??
      resolveReplyFailureSummary({
        error,
        message,
        facts: failoverFacts,
        attempts: readFallbackAttempts(error),
      });
    if (summary) {
      return { text: summary.text, isGenericRunnerFailure: false };
    }
  }
  if (error instanceof FailoverError && error.userMessage) {
    return { text: error.userMessage, isGenericRunnerFailure: false, summaryAsTitle: true };
  }
  const providerRequestError = failoverFacts.providerRequestError;
  if (
    options?.failureSummary &&
    (options.shouldSurfaceToControlUi ||
      options.failureSummary.kind === "billing" ||
      !providerRequestError)
  ) {
    return { text: options.failureSummary.text, isGenericRunnerFailure: false };
  }
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
  const codexAppServerFailure = renderCodexAppServerFailureCopy(normalizedMessage);
  if (codexAppServerFailure) {
    return { text: codexAppServerFailure, isGenericRunnerFailure: false };
  }
  const classifiedFailure =
    failoverFacts.requestFailureText ?? renderAssistantRequestFailureCopy(failoverFacts);
  if (classifiedFailure) {
    return { text: classifiedFailure, isGenericRunnerFailure: false };
  }
  // Only unclassified thrown text reaches this branch. Verbose mode is the
  // explicit opt-in because sanitization does not make raw provider bodies safe.
  return {
    text: options?.shouldSurfaceToControlUi
      ? renderControlUiAgentFailureCopy()
      : options?.includeDetails
        ? formatForwardedExternalRunFailureText(
            renderUserFacingText(normalizedMessage, { errorContext: true }),
          )
        : GENERIC_EXTERNAL_RUN_FAILURE_TEXT,
    isGenericRunnerFailure: true,
  };
}

export function markAgentRunFailureReplyPayload<T extends ReplyPayload>(payload: T): T {
  const marked = markReplyPayloadForSourceSuppressionDelivery(payload);
  marked.isError = true;
  return marked;
}

export function markPostCompactionModelFailurePayload(
  postCompactionModelFailure: true | undefined,
  payload: ReplyPayload,
): ReplyPayload {
  return postCompactionModelFailure === true &&
    payload.isError === true &&
    isReplyPayloadTerminalContent(payload) &&
    payload.text !== undefined
    ? setReplyPayloadMetadata(payload, { postCompactionModelFailure: true })
    : payload;
}

export function renderPostCompactionModelFailurePayload(payload: ReplyPayload): ReplyPayload {
  return getReplyPayloadMetadata(payload)?.postCompactionModelFailure === true &&
    payload.text !== undefined
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
    ? ""
    : params.text;
}

export function buildTerminalAgentRunFailureReplyPayload(params: {
  replyExpectation: ReplyExpectation;
  visibleReplyDelivered: boolean;
}): ReplyPayload {
  return markAgentRunFailureReplyPayload({
    text: resolveAgentRunFailureText({
      ...params,
      text: GENERIC_EXTERNAL_RUN_FAILURE_TEXT,
      isGenericRunnerFailure: true,
    }),
  });
}

/** Lifts the owned failure notice without inventing chat output for a background empty turn. */
export async function resolveTerminalAgentRunFailurePayload(params: {
  result: EmbeddedAgentRunResult;
  run: Parameters<typeof shouldDeliverMissingReplyNotice>[0];
  visibleReplyDelivered: () => Promise<boolean>;
}): Promise<ReplyPayload | undefined> {
  const terminalError = params.result.meta?.error;
  const missingReplyNotice =
    terminalError?.kind === "incomplete_turn" &&
    terminalError.message.startsWith(MISSING_REPLY_NOTICE_TEXT);
  const suppressMissingReplyNotice =
    missingReplyNotice && !shouldDeliverMissingReplyNotice(params.run);
  // A canonical provider refusal is the run's own failure notice, not generic copy.
  const ownedFailureNotice = params.result.payloads?.find(
    (payload) =>
      payload.isError === true &&
      ((payload.isStatusNotice === true &&
        getReplyPayloadMetadata(payload)?.assistantTranscriptOwned === true) ||
        isProviderRefusalNoticeText(payload.text ?? "")),
  );
  if (ownedFailureNotice) {
    params.result.payloads = params.result.payloads?.filter(
      (payload) => payload !== ownedFailureNotice,
    );
    return suppressMissingReplyNotice
      ? undefined
      : markAgentRunFailureReplyPayload(ownedFailureNotice);
  }
  if (suppressMissingReplyNotice) {
    return undefined;
  }
  if (missingReplyNotice) {
    return markAgentRunFailureReplyPayload(createMissingReplyNotice(terminalError.message));
  }
  const replyExpectation = resolveReplyExpectation(params.run);
  return buildTerminalAgentRunFailureReplyPayload({
    replyExpectation,
    visibleReplyDelivered:
      replyExpectation === "optional" ? await params.visibleReplyDelivered() : false,
  });
}

export function buildKnownAgentRunFailureReplyPayload(params: {
  err: unknown;
  sessionCtx: TemplateContext;
  resolvedVerboseLevel: VerboseLevel | undefined;
  config?: OpenClawConfig;
}): ReplyPayload | undefined {
  // Preflight diagnostics are not provider failures. Only explicit public copy
  // can bypass the caller's diagnostic disclosure policy.
  const message = formatErrorMessage(params.err);
  if (isAgentHarnessPreflightError(params.err) || findLocalWorkerTaskFailure(params.err)) {
    const reply = buildExternalRunFailureReply({
      message,
      error: params.err,
    });
    return reply.isGenericRunnerFailure
      ? undefined
      : markAgentRunFailureReplyPayload({ text: reply.text });
  }
  const failoverFacts = resolveReplyFailoverFacts(params.err, message, params.config);
  const failureSummary = resolveReplyFailureSummary({
    error: params.err,
    message,
    facts: failoverFacts,
    attempts: readFallbackAttempts(params.err),
    config: params.config,
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
