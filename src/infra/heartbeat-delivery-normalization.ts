import { STREAM_ERROR_FALLBACK_TEXT } from "@openclaw/ai/internal/shared";
import {
  hasOutboundReplyContent,
  resolveSendableOutboundReplyParts,
} from "openclaw/plugin-sdk/reply-payload";
import { replaceGenericExternalRunFailureText } from "../agents/failover/user-copy.js";
import type { ReplyCompletion } from "../agents/reply-completion.js";
import type { HeartbeatTerminalToolFailure } from "../auto-reply/heartbeat-reply-payload.js";
import {
  getHeartbeatToolNotificationText,
  type HeartbeatToolResponse,
} from "../auto-reply/heartbeat-tool-response.js";
import { stripHeartbeatToken } from "../auto-reply/heartbeat.js";
import { copyReplyPayloadMetadata, getReplyPayloadMetadata } from "../auto-reply/reply-payload.js";
import type { ReplyPayload } from "../auto-reply/types.js";
import { escapeRegExp } from "../utils.js";
import { truncateHeartbeatPreview } from "./heartbeat-runner-prompt.js";

export type NormalizedHeartbeatDelivery = {
  shouldSkip: boolean;
  text: string;
  hasMedia: boolean;
  isInternalPlaceholderOnly: boolean;
  silent?: boolean;
};

const TRAILING_HEARTBEAT_NOTIFY_FALSE_RE = /(?:^|[\r\n])[ \t]*notify=false[ \t]*(?:\r?\n[ \t]*)*$/i;

export function classifyHeartbeatAgentOutcome(params: {
  agentRun: {
    agentRunFailed: boolean;
    heartbeatToolResponse?: HeartbeatToolResponse;
    heartbeatTerminalToolFailure?: HeartbeatTerminalToolFailure;
    replyPayload?: ReplyPayload;
    replyCompletion?: ReplyCompletion;
  };
  useHeartbeatFailureCopy: boolean;
  hasRelayableExecCompletion: boolean;
  suppressUnmarkedSourceReplies: boolean;
  responsePrefix: string | undefined;
  ackMaxChars: number;
}) {
  const {
    agentRunFailed,
    heartbeatToolResponse,
    heartbeatTerminalToolFailure,
    replyPayload,
    replyCompletion,
  } = params.agentRun;
  const replyMetadata = replyPayload ? getReplyPayloadMetadata(replyPayload) : undefined;
  const hasExplicitFailure = Boolean(heartbeatTerminalToolFailure || agentRunFailed);
  const shouldSuppressSourceReply =
    params.suppressUnmarkedSourceReplies &&
    !params.hasRelayableExecCompletion &&
    replyPayload &&
    replyPayload.isError !== true &&
    replyMetadata?.deliverDespiteSourceReplySuppression !== true &&
    ((!hasExplicitFailure && !heartbeatToolResponse) ||
      (agentRunFailed && !heartbeatTerminalToolFailure));
  if (heartbeatToolResponse && !heartbeatToolResponse.notify && !hasExplicitFailure) {
    return {
      kind: "ack",
      eventStatus: "ok-token",
      preview: truncateHeartbeatPreview(heartbeatToolResponse.summary),
      response: heartbeatToolResponse,
    } as const;
  }
  if (shouldSuppressSourceReply && !hasExplicitFailure) {
    // Message-tool privacy never makes an ordinary assistant final outbound;
    // marked operator notices and terminal failures keep their visible paths.
    return { kind: "ack", eventStatus: "ok-token", silent: true } as const;
  }
  if (
    !heartbeatToolResponse &&
    !hasExplicitFailure &&
    (!replyPayload || !hasOutboundReplyContent(replyPayload))
  ) {
    return replyCompletion?.outcome === "silent"
      ? ({
          kind: "ack",
          eventStatus: "ok-token",
          silent: params.hasRelayableExecCompletion,
        } as const)
      : ({ kind: "ack", eventStatus: "ok-empty" } as const);
  }
  const mode = params.hasRelayableExecCompletion ? "message" : "heartbeat";
  let finalText: string;
  let hasMedia = false;
  let isInternalPlaceholderOnly = false;
  let normalizedSilent: boolean;
  const responsePrefix = params.responsePrefix;
  if (
    heartbeatToolResponse &&
    !shouldSuppressSourceReply &&
    !(hasExplicitFailure && replyPayload)
  ) {
    finalText = getHeartbeatToolNotificationText(heartbeatToolResponse);
    normalizedSilent = !heartbeatToolResponse.notify;
  } else {
    const payload = shouldSuppressSourceReply ? {} : (replyPayload ?? {});
    const ackMaxChars = params.ackMaxChars;
    const rawText = typeof payload.text === "string" ? payload.text : "";
    const normalizedPrefix = responsePrefix?.trim();
    const textForStrip = normalizedPrefix
      ? rawText.replace(
          new RegExp(`^${escapeRegExp(normalizedPrefix)}(?=$|\\s|[\\p{P}\\p{S}])\\s*`, "iu"),
          "",
        )
      : rawText;
    const stripped = stripHeartbeatToken(textForStrip, {
      mode,
      maxAckChars: ackMaxChars,
    });
    hasMedia = resolveSendableOutboundReplyParts(payload).hasMedia;
    const match = TRAILING_HEARTBEAT_NOTIFY_FALSE_RE.exec(stripped.text);
    const notifyFalse = match
      ? { text: stripped.text.slice(0, match.index).trimEnd(), silent: true }
      : { text: stripped.text, silent: false };
    normalizedSilent = notifyFalse.silent || replyCompletion?.outcome === "silent";
    let remaining = notifyFalse.text.trim();
    const hasRemaining = remaining.length > 0;
    while (remaining.startsWith(STREAM_ERROR_FALLBACK_TEXT)) {
      remaining = remaining.slice(STREAM_ERROR_FALLBACK_TEXT.length).trimStart();
    }
    isInternalPlaceholderOnly = hasRemaining && remaining.length === 0;
    finalText =
      (stripped.shouldSkip && !hasMedia) || isInternalPlaceholderOnly ? "" : notifyFalse.text;
  }
  if (responsePrefix && finalText && !finalText.startsWith(responsePrefix)) {
    finalText = `${responsePrefix} ${finalText}`;
  }
  const normalized: NormalizedHeartbeatDelivery = {
    shouldSkip: !hasMedia && finalText.trim().length === 0,
    text: finalText,
    hasMedia,
    isInternalPlaceholderOnly,
    ...(normalizedSilent ? { silent: true } : {}),
  };
  if (agentRunFailed && params.useHeartbeatFailureCopy) {
    const replacement = replaceGenericExternalRunFailureText(normalized.text);
    if (replacement.replaced) {
      normalized.text = replacement.text;
      normalized.shouldSkip = false;
    }
  }
  const hasStructuredReplyContent =
    !shouldSuppressSourceReply &&
    (!heartbeatToolResponse || agentRunFailed) &&
    replyPayload !== undefined &&
    hasOutboundReplyContent(
      copyReplyPayloadMetadata(replyPayload, {
        ...replyPayload,
        text: undefined,
        mediaUrl: undefined,
        mediaUrls: undefined,
      }),
    );
  const shouldSkipMain =
    // A completed quiet turn also suppresses tool warnings and media; a later crash does not.
    (!agentRunFailed && heartbeatToolResponse?.notify === false) ||
    (normalized.shouldSkip && (!hasStructuredReplyContent || normalized.isInternalPlaceholderOnly));
  if (hasExplicitFailure) {
    return {
      kind: "failure",
      reason: heartbeatTerminalToolFailure ? "agent-tool-failure" : "agent-runner-failure",
      ...(heartbeatTerminalToolFailure
        ? {
            previewText: heartbeatToolResponse?.summary || heartbeatTerminalToolFailure.toolName,
          }
        : {}),
      replyPayload: shouldSuppressSourceReply ? undefined : replyPayload,
      normalized,
      shouldSkipMain,
    } as const;
  }
  if (shouldSkipMain) {
    // A heartbeat's canonical quiet reply still honors explicit showOk; event
    // relays and message-tool privacy retain their unconditional silence.
    const silent =
      normalized.silent && !(mode === "heartbeat" && replyCompletion?.outcome === "silent");
    return { kind: "ack", eventStatus: "ok-token", silent } as const;
  }
  return {
    kind: "delivery",
    response: heartbeatToolResponse,
    normalized,
    hasStructuredReplyContent,
    replyPayload: heartbeatToolResponse ? undefined : replyPayload,
    mediaUrls:
      heartbeatToolResponse || !replyPayload
        ? []
        : resolveSendableOutboundReplyParts(replyPayload).mediaUrls,
  } as const;
}
