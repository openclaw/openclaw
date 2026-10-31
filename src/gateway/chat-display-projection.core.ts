import { GATEWAY_ASSISTANT_ERROR_FALLBACK_TEXT } from "@openclaw/gateway-protocol/gateway-error-details";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { STREAM_ERROR_FALLBACK_TEXT } from "../../packages/ai/src/replay-turn-classification.js";
import {
  renderAssistantRequestFailureCopy,
  renderRecordedAssistantFailureCopy,
} from "../agents/failover/assistant-request-failure-copy.js";
import { readTranscriptSenderIdentity } from "../chat/sender-identity.js";
import { projectPreservedCatalogMessageForDisplay } from "../chat/session-catalog-display.js";
import {
  projectAgentHistoryActivity,
  type AgentHistoryActivity,
} from "../infra/agent-activity-events.js";
import { classifyGatewayStorageFailure } from "../infra/sqlite-error-diagnostics.js";
import {
  readNestedToolActivity,
  nestedToolActivityContent,
} from "../sessions/nested-tool-activity.js";
import {
  readSessionTranscriptFailureRunId,
  readSessionTranscriptRunId,
} from "../sessions/transcript-events.js";
import {
  CONTEXT_OVERFLOW_ERROR_MESSAGE,
  formatProviderRefusalText,
} from "../shared/assistant-error-format.js";
import { readRunFailureNotice } from "../shared/run-failure-notice.js";
import {
  isOpenClawMessageToolMirrorAssistantMessage,
  isTranscriptOnlyOpenClawAssistantMessage,
} from "../shared/transcript-only-openclaw-assistant.js";
import {
  DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS,
  extractAssistantTextForSilentCheck,
  hasAssistantDisplayableNonTextContent,
  hasAssistantNonTextContent,
  hasTranscriptMediaFacts,
  isAssistantTextContentType,
  isAssistantInternalReasoningContentType,
  projectReplyMediaFailureText,
} from "./chat-display-projection.helpers.js";
import {
  createSubagentCoordinationHistoryProjection,
  filterVisibleProjectedHistoryMessages,
  mergeTtsSupplementMessages,
  projectForwardedMessages,
  projectPluginSteeringMessage,
  toProjectedMessages,
} from "./chat-display-projection.history.js";
import { mapChatDisplayMessages } from "./chat-display-projection.map.js";
import {
  prepareAssistantHistoryMessage,
  sanitizeChatHistoryContentBlock,
  sanitizeChatHistoryMessage,
  sanitizeChatHistoryMessages,
  shouldDropAssistantHistoryMessage,
} from "./chat-display-projection.sanitize.js";
import { stripEnvelopeFromMessages } from "./chat-sanitize.js";
import type {
  CurrentUserProfileDisplay,
  CurrentUserProfileDisplayResolver,
} from "./current-user-profile-display.js";
import type { SubagentCoordinationDisplayResolver } from "./session-transcript-read.types.js";
import { projectTranscriptImageArtifacts } from "./transcript-image-artifacts.js";

export type ChatDisplayProjectionOptions = {
  resolveCronJobName?: (jobId: string) => string | undefined;
  includeCommentaryFallbacks?: boolean;
  includePluginSteering?: boolean;
  maxChars?: number;
  toolResultMaxChars?: number;
  activity?: false;
  resolveCurrentUserProfileDisplay?: CurrentUserProfileDisplayResolver;
  stripEnvelope?: boolean;
  turnBoundaryPending?: boolean;
  assistantErrorPending?: boolean;
  subagentCoordination?: SubagentCoordinationDisplayResolver;
};

/** Keep profile display reads local to one history page or event projection operation. */
export function createCurrentUserProfileMessageProjector(
  resolveDisplay: CurrentUserProfileDisplayResolver,
) {
  const displayBySenderId = new Map<string, CurrentUserProfileDisplay>();
  return (message: Record<string, unknown>): Record<string, unknown> => {
    if (message.role !== "user") {
      return message;
    }
    const metadata = asOptionalRecord(message["__openclaw"]);
    if (!metadata) {
      return message;
    }
    const identity = readTranscriptSenderIdentity(metadata.senderIdentity);
    if (identity?.type !== "profile") {
      return message;
    }
    const senderId = identity.id;
    let display = displayBySenderId.get(senderId);
    if (!display) {
      display = resolveDisplay(senderId);
      displayBySenderId.set(senderId, display);
    }
    if (display.kind === "unresolved") {
      return message;
    }
    if (
      metadata.senderProfileAvatarUrl === display.avatarUrl &&
      identity.id === display.profileId
    ) {
      return message;
    }
    return {
      ...message,
      __openclaw: {
        ...metadata,
        senderIdentity: { type: "profile", id: display.profileId },
        senderProfileAvatarUrl: display.avatarUrl,
      },
    };
  };
}

function projectCurrentUserProfileAvatars(
  messages: Array<Record<string, unknown>>,
  resolveDisplay: CurrentUserProfileDisplayResolver | undefined,
): Array<Record<string, unknown>> {
  if (!resolveDisplay) {
    return messages;
  }
  return mapChatDisplayMessages(messages, createCurrentUserProfileMessageProjector(resolveDisplay));
}

type ChatDisplayProjectionResult = {
  messages: Array<Record<string, unknown>>;
  activity: AgentHistoryActivity[];
  turnBoundaryPending: boolean;
  assistantErrorPending: boolean;
  assistantErrorRecoveryObserved: boolean;
  commentaryFallbacksObserved?: true;
};

function getAssistantErrorFallbackText(message: Record<string, unknown>): string {
  return (
    formatProviderRefusalText(message) ??
    renderAssistantRequestFailureCopy({
      storageFailure: classifyGatewayStorageFailure(message),
      code: typeof message.errorCode === "string" ? message.errorCode : undefined,
    }) ??
    renderRecordedAssistantFailureCopy(message) ??
    GATEWAY_ASSISTANT_ERROR_FALLBACK_TEXT
  );
}

function sanitizeAssistantErrorDisplayMessage(
  message: Record<string, unknown>,
  includeFailureCopy = true,
): Record<string, unknown> {
  const { content, ...envelope } = message;
  let next = sanitizeChatHistoryMessage(envelope, Number.MAX_SAFE_INTEGER).message as Record<
    string,
    unknown
  >;
  if (Array.isArray(content)) {
    let firstTextBlock = true;
    next.content = content.flatMap((block) => {
      const sanitized = sanitizeChatHistoryContentBlock(block, {
        maxChars: Number.MAX_SAFE_INTEGER,
      }).block;
      if (!sanitized || typeof sanitized !== "object" || Array.isArray(sanitized)) {
        return [sanitized];
      }
      const entry = sanitized as { type?: unknown; text?: unknown };
      if (isAssistantInternalReasoningContentType(entry.type)) {
        return [];
      }
      if (!firstTextBlock || !isAssistantTextContentType(entry.type)) {
        return [sanitized];
      }
      firstTextBlock = false;
      if (typeof entry.text !== "string" || !entry.text.startsWith(STREAM_ERROR_FALLBACK_TEXT)) {
        return [sanitized];
      }
      const replyText = entry.text.slice(STREAM_ERROR_FALLBACK_TEXT.length);
      return replyText ? [{ ...entry, text: replyText }] : [];
    });
  } else {
    next.content =
      typeof content === "string" && content.startsWith(STREAM_ERROR_FALLBACK_TEXT)
        ? content.slice(STREAM_ERROR_FALLBACK_TEXT.length)
        : content;
  }
  if (typeof next.text === "string" && next.text.startsWith(STREAM_ERROR_FALLBACK_TEXT)) {
    next.text = next.text.slice(STREAM_ERROR_FALLBACK_TEXT.length);
  }
  const terminalCopy =
    formatProviderRefusalText(message) ??
    renderAssistantRequestFailureCopy({
      code: typeof message.errorCode === "string" ? message.errorCode : undefined,
    }) ??
    renderRecordedAssistantFailureCopy(message);
  if (includeFailureCopy && terminalCopy) {
    // Apply the normal visibility rules before adding host-owned failure copy.
    // Put it first in surviving text so phase filtering and display caps retain it.
    // SAFETY: Sanitizing a record only clones/filters its fields; its envelope remains a record.
    next = sanitizeChatHistoryMessage(next, Number.MAX_SAFE_INTEGER).message as Record<
      string,
      unknown
    >;
    if (shouldDropAssistantHistoryMessage(next)) {
      next.content = [];
      delete next.text;
      delete next.phase;
    }
    const displayContent: unknown[] = Array.isArray(next.content)
      ? [...next.content]
      : typeof next.content === "string"
        ? [{ type: "text", text: next.content }]
        : [];
    const prependText = (text: string) => {
      const alreadyPresent = displayContent.some((block) => {
        const entry = asOptionalRecord(block);
        return (
          entry &&
          isAssistantTextContentType(entry.type) &&
          typeof entry.text === "string" &&
          entry.text.includes(text)
        );
      });
      if (!text || alreadyPresent) {
        return;
      }
      const textIndex = displayContent.findIndex((block) => {
        const entry = asOptionalRecord(block);
        return entry && isAssistantTextContentType(entry.type) && typeof entry.text === "string";
      });
      const previous = textIndex >= 0 ? asOptionalRecord(displayContent[textIndex]) : undefined;
      if (previous) {
        displayContent[textIndex] = {
          ...previous,
          text: [text, previous.text].filter(Boolean).join("\n\n"),
        };
      } else {
        displayContent.push({ type: "text", text });
      }
    };
    if (typeof next.text === "string") {
      prependText(next.text);
    }
    prependText(getAssistantErrorFallbackText(message));
    next.content = displayContent;
    delete next.text;
  }
  delete next.diagnostics;
  delete next.errorBody;
  delete next.errorCode;
  delete next.errorMessage;
  delete next.errorType;
  return next;
}

function isPureStreamErrorFallbackAssistantMessage(message: Record<string, unknown>): boolean {
  if (message.role !== "assistant" || message.stopReason !== "error") {
    return false;
  }
  const text = extractAssistantTextForSilentCheck(message);
  return (
    text !== undefined &&
    text.trim() === STREAM_ERROR_FALLBACK_TEXT &&
    !hasAssistantNonTextContent(message) &&
    !hasTranscriptMediaFacts(message)
  );
}

function hasVisibleAssistantDisplayContent(message: Record<string, unknown>): boolean {
  if (
    message.role !== "assistant" ||
    message.display === false ||
    isPureStreamErrorFallbackAssistantMessage(message)
  ) {
    return false;
  }
  const sanitized = sanitizeChatHistoryMessage(message, Number.MAX_SAFE_INTEGER).message as Record<
    string,
    unknown
  >;
  if (shouldDropAssistantHistoryMessage(message)) {
    return false;
  }
  if (hasAssistantDisplayableNonTextContent(sanitized) || hasTranscriptMediaFacts(sanitized)) {
    return true;
  }
  return hasVisibleAssistantReplyText(sanitized);
}

function hasVisibleAssistantReplyText(message: Record<string, unknown>): boolean {
  const texts = Array.isArray(message.content)
    ? message.content.flatMap((block) => {
        const entry = asOptionalRecord(block);
        return isAssistantTextContentType(entry?.type) ? [entry?.text] : [];
      })
    : [message.content];
  return [...texts, message.text].some((text) => {
    if (typeof text !== "string") {
      return false;
    }
    const visible = text.trim();
    return visible.length > 0 && visible !== STREAM_ERROR_FALLBACK_TEXT;
  });
}

function isCompletedAssistantMessage(message: Record<string, unknown>): boolean {
  return (
    message.role === "assistant" &&
    (message.stopReason === "stop" || message.stopReason === "length")
  );
}

/** Sanitized reasoning is display material without being a recovery-completing answer. */
function hasAssistantHistoryMaterial(message: Record<string, unknown>): boolean {
  return (
    hasVisibleAssistantReplyText(message) ||
    hasAssistantDisplayableNonTextContent(message) ||
    hasTranscriptMediaFacts(message) ||
    (Array.isArray(message.content) &&
      message.content.some((block) => {
        const entry = asOptionalRecord(block);
        return (
          isAssistantInternalReasoningContentType(entry?.type) &&
          [entry?.thinking, entry?.text].some(
            (value) => typeof value === "string" && value.trim().length > 0,
          )
        );
      }))
  );
}

function isDiagnosticOnlyAssistantError(value: unknown): boolean {
  const message = asOptionalRecord(value);
  return (
    message?.role === "assistant" &&
    message.display !== false &&
    message.stopReason === "error" &&
    (isPureStreamErrorFallbackAssistantMessage(message) ||
      (Boolean(readSessionTranscriptRunId(message)) &&
        !hasAssistantDisplayableNonTextContent(message) &&
        !hasTranscriptMediaFacts(message) &&
        (!hasVisibleAssistantDisplayContent(message) ||
          // Older projections stored the host error copy as assistant text. It
          // is diagnostic-only, but partial answers and media must stay visible.
          extractAssistantTextForSilentCheck(message)
            ?.trim()
            .replace(/^⚠️\s*/u, "") === CONTEXT_OVERFLOW_ERROR_MESSAGE)))
  );
}

export function isPendingAssistantError(value: unknown): boolean {
  const message = asOptionalRecord(value);
  return Boolean(
    message?.role === "assistant" &&
    message.display !== false &&
    message.stopReason === "error" &&
    (readSessionTranscriptRunId(message) || isPureStreamErrorFallbackAssistantMessage(message)),
  );
}

/** Retain authored output, never a model attempt's host-owned failure copy. */
function projectAssistantAttemptContent(message: Record<string, unknown>) {
  const diagnosticOnly = isDiagnosticOnlyAssistantError(message);
  const next = sanitizeAssistantErrorDisplayMessage(message, false);
  delete next.stopReason;
  delete next.openclawRunError;
  if (diagnosticOnly) {
    next.content = [];
    delete next.text;
  }
  return hasVisibleAssistantDisplayContent(next) ? next : undefined;
}

/** Hidden retry prompts continue a turn; only a real user input ends recovery matching. */
export function isChatHistoryRecoveryUserBoundary(value: unknown): boolean {
  const message = asOptionalRecord(value);
  return (
    message?.role === "user" &&
    !(message.display === false && asOptionalRecord(message.provenance)?.kind === "internal_system")
  );
}

export function createChatHistoryRecoveryProjection(options?: ChatHistoryRecoveryOptions) {
  const projectCoordination = createSubagentCoordinationHistoryProjection(
    options?.subagentCoordination,
  );
  const messages: Array<Record<string, unknown>> = [];
  let unseenPending = options?.assistantErrorPending ?? false;
  let recoveryObserved = false;
  let pendingIndexes: number[] = [];
  const repairedIndexes = new Set<number>();
  const append = (message: Record<string, unknown>) => {
    const receiptRunId =
      readSessionTranscriptFailureRunId(message) ?? readRunFailureNotice(message)?.runId;
    if (receiptRunId) {
      pendingIndexes = pendingIndexes.filter((pendingIndex) => {
        if (readSessionTranscriptRunId(messages[pendingIndex]) !== receiptRunId) {
          return true;
        }
        repairedIndexes.add(pendingIndex);
        recoveryObserved = true;
        return false;
      });
    }
    const index = messages.length;
    messages.push(message);
    if (isChatHistoryRecoveryUserBoundary(message)) {
      unseenPending = false;
      pendingIndexes = [];
      return;
    }
    if (isPendingAssistantError(message) || readRunFailureNotice(message)) {
      pendingIndexes.push(index);
      return;
    }
    if (
      (!unseenPending && pendingIndexes.length === 0) ||
      !hasVisibleAssistantDisplayContent(message)
    ) {
      return;
    }
    // An incremental reader carries only a pending bit. It must reload raw
    // history before deciding which previously emitted failures were recovered.
    recoveryObserved ||= unseenPending;
    unseenPending = false;
    const completedRunId =
      (message.stopReason === "stop" || message.stopReason === "length") &&
      !isTranscriptOnlyOpenClawAssistantMessage(message)
        ? readSessionTranscriptRunId(message)
        : undefined;
    pendingIndexes = pendingIndexes.filter((pendingIndex) => {
      const failedRunId = readSessionTranscriptRunId(messages[pendingIndex]);
      // Unattributed legacy stream sentinels retain their existing turn-local
      // repair. Runtime attempt failures require completion of the exact run.
      if (failedRunId && failedRunId !== completedRunId) {
        return true;
      }
      repairedIndexes.add(pendingIndex);
      recoveryObserved = true;
      return false;
    });
  };
  return {
    append(input: unknown[]) {
      const projected = projectCoordination(prepareChatHistoryRecoveryMessages(input, options));
      for (const message of toProjectedMessages(projected)) {
        if (!isOpenClawMessageToolMirrorAssistantMessage(message)) {
          append(message);
        }
      }
    },
    get pending() {
      return unseenPending || pendingIndexes.length > 0;
    },
    result() {
      return {
        messages:
          repairedIndexes.size > 0
            ? messages.flatMap((message, index) => {
                if (!repairedIndexes.has(index)) {
                  return [message];
                }
                const partial = projectAssistantAttemptContent(message);
                return partial ? [partial] : [];
              })
            : messages.slice(),
        pending: unseenPending || pendingIndexes.length > 0,
        recoveryObserved,
      };
    },
  };
}

/** Only the terminal lifecycle owner may turn attempt diagnostics into a notice. */
function projectRunFailureNotices(
  messages: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return messages.flatMap((message) => {
    if (message.role === "custom" && message.customType === "run-failed-before-reply") {
      const runId =
        readSessionTranscriptFailureRunId(message) ?? readSessionTranscriptRunId(message);
      const summary =
        readRunFailureNotice(message)?.summary ??
        (typeof message.content === "string" ? message.content.trim() : undefined);
      return runId && summary ? [{ ...message, openclawRunError: { runId, summary } }] : [message];
    }
    if (readSessionTranscriptRunId(message) && isPendingAssistantError(message)) {
      // Legacy receipt-less attempts stay in the raw transcript. Inactivity or
      // a bounded page cannot establish that the logical run exhausted recovery.
      const partial = projectAssistantAttemptContent(message);
      return partial ? [partial] : [];
    }
    return [message];
  });
}

function projectEmptyAssistantErrorMessages(
  messages: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return mapChatDisplayMessages(messages, (message) => {
    if (message.role !== "assistant" || message.stopReason !== "error") {
      return message;
    }
    const hasDisplayableStructuredContent =
      hasAssistantDisplayableNonTextContent(message) || hasTranscriptMediaFacts(message);
    if (hasDisplayableStructuredContent) {
      return sanitizeAssistantErrorDisplayMessage(message);
    }
    const sanitized = sanitizeChatHistoryMessage(message, Number.MAX_SAFE_INTEGER)
      .message as Record<string, unknown>;
    if (!shouldDropAssistantHistoryMessage(sanitized) && hasVisibleAssistantReplyText(sanitized)) {
      return sanitizeAssistantErrorDisplayMessage(message);
    }
    const next: Record<string, unknown> = {
      ...sanitized,
      content: [{ type: "text", text: getAssistantErrorFallbackText(message) }],
    };
    delete next.diagnostics;
    delete next.errorBody;
    delete next.errorCode;
    delete next.errorMessage;
    delete next.errorType;
    delete next.phase;
    delete next.text;
    return next;
  });
}

type ChatHistoryRecoveryOptions = Pick<
  ChatDisplayProjectionOptions,
  "maxChars" | "stripEnvelope" | "assistantErrorPending" | "subagentCoordination"
>;

export function prepareChatHistoryRecoveryMessages(
  messages: unknown[],
  options?: ChatHistoryRecoveryOptions,
) {
  const projectedMessages = messages.map((original) => {
    const message = projectTranscriptImageArtifacts(prepareAssistantHistoryMessage(original));
    const entry = asOptionalRecord(message);
    const failureRunId = readSessionTranscriptFailureRunId(entry);
    if (failureRunId) {
      // Retain failure correlation before sanitation removes private report details.
      return {
        ...entry,
        __openclaw: { ...asOptionalRecord(entry?.["__openclaw"]), runId: failureRunId },
      };
    }
    const activity = readNestedToolActivity(message);
    if (!activity) {
      return message;
    }
    const [call, result] = nestedToolActivityContent(activity);
    const sanitized = sanitizeChatHistoryMessage(
      { ...result, role: "toolResult" },
      options?.maxChars ?? DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS,
    ).message;
    return {
      ...asOptionalRecord(message),
      runId: activity.details.runId,
      // The entry dedupe key identifies a nested call, not its owning run.
      // Publish validated ownership where history and live clients read it.
      __openclaw: {
        ...asOptionalRecord(asOptionalRecord(message)?.["__openclaw"]),
        runId: activity.details.runId,
      },
      content: [call, sanitized],
    };
  });
  return options?.stripEnvelope === false
    ? projectedMessages
    : stripEnvelopeFromMessages(projectedMessages);
}

export function projectChatDisplayMessagesWithState(
  messages: unknown[],
  options?: ChatDisplayProjectionOptions,
): ChatDisplayProjectionResult {
  options?.subagentCoordination?.assertCurrent?.();
  const recovery = createChatHistoryRecoveryProjection(options);
  const catalogDisplay = messages.flatMap(projectPreservedCatalogMessageForDisplay);
  recovery.append(catalogDisplay);
  const recoveredErrors = recovery.result();
  const projectedErrors = projectEmptyAssistantErrorMessages(
    projectRunFailureNotices(recoveredErrors.messages),
  );
  const activity =
    options?.activity === false
      ? []
      : projectAgentHistoryActivity(
          messages.flatMap((message) => {
            const messageId = asOptionalRecord(asOptionalRecord(message)?.["__openclaw"])?.id;
            return typeof messageId === "string" ? [{ messageId, message }] : [];
          }),
        );
  // Imported catalog facts already own their presentation; stored reference text has no tool blocks.
  if (options?.activity !== false) {
    for (const message of catalogDisplay) {
      const record = asOptionalRecord(message);
      const id = asOptionalRecord(record?.["__openclaw"])?.id;
      if (
        asOptionalRecord(record?.["__openclaw"])?.catalogSource === true &&
        typeof id === "string" &&
        Array.isArray(record?.activity)
      ) {
        activity.push({ messageId: id, items: record.activity });
      }
    }
  }
  // Recovery already admitted records and consumed assistant display content.
  const sanitizedMessages = sanitizeChatHistoryMessages(projectedErrors, Number.MAX_SAFE_INTEGER, {
    includeCommentaryFallbacks: options?.includeCommentaryFallbacks,
  }).filter(
    (message) => !isCompletedAssistantMessage(message) || hasAssistantHistoryMaterial(message),
  );
  const commentaryFallbacksObserved =
    options?.includeCommentaryFallbacks === true &&
    sanitizedMessages.some(
      (message) => asOptionalRecord(message.openclawStreamFallback)?.source === "segment",
    );
  const filtered = filterVisibleProjectedHistoryMessages(
    projectForwardedMessages(
      options?.includePluginSteering
        ? mapChatDisplayMessages(sanitizedMessages, projectPluginSteeringMessage)
        : sanitizedMessages,
      options?.resolveCronJobName,
    ),
    options?.turnBoundaryPending,
  );
  const displayMessages = sanitizeChatHistoryMessages(
    mapChatDisplayMessages(
      mergeTtsSupplementMessages(filtered.messages),
      projectReplyMediaFailureText,
    ),
    options?.maxChars ?? DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS,
    { toolResultMaxChars: options?.toolResultMaxChars },
  );
  const result: ChatDisplayProjectionResult = {
    activity,
    messages: projectCurrentUserProfileAvatars(
      displayMessages,
      options?.resolveCurrentUserProfileDisplay,
    ),
    turnBoundaryPending: filtered.turnBoundaryPending,
    assistantErrorPending: recoveredErrors.pending,
    assistantErrorRecoveryObserved: recoveredErrors.recoveryObserved,
  };
  if (commentaryFallbacksObserved) {
    result.commentaryFallbacksObserved = true;
  }
  options?.subagentCoordination?.assertCurrent?.();
  return result;
}

export function projectChatDisplayMessages(
  messages: unknown[],
  options?: ChatDisplayProjectionOptions,
): Array<Record<string, unknown>> {
  return projectChatDisplayMessagesWithState(messages, { ...options, activity: false }).messages;
}

export function projectChatDisplayMessage(
  message: unknown,
  options?: ChatDisplayProjectionOptions,
): Record<string, unknown> | undefined {
  const projected = projectChatDisplayMessages([message], options);
  if (
    !options?.includeCommentaryFallbacks ||
    !projected.some((entry) => entry.openclawStreamFallback)
  ) {
    return projected[0];
  }
  // A fetched source row restores all its visible fragments as one message.
  const result: Record<string, unknown> = {
    ...projected.at(-1),
    content: projected.flatMap(({ content }) =>
      Array.isArray(content)
        ? content
        : typeof content === "string"
          ? [{ type: "text", text: content }]
          : [],
    ),
  };
  const truncated = projected
    .map((entry) => asOptionalRecord(entry["__openclaw"]))
    .find((metadata) => metadata?.truncated === true);
  if (truncated) {
    result["__openclaw"] = {
      ...asOptionalRecord(result["__openclaw"]),
      truncated: true,
      reason: truncated.reason,
    };
  }
  delete result.openclawStreamFallback;
  return result;
}
