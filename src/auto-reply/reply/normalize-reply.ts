import { sanitizeUserFacingText } from "../../agents/pi-embedded-helpers.js";
import { hasReplyChannelData, hasReplyContent } from "../../interactive/payload.js";
import { stripHeartbeatToken } from "../heartbeat.js";
import {
  HEARTBEAT_TOKEN,
  isSilentReplyText,
  SILENT_REPLY_TOKEN,
  stripSilentToken,
} from "../tokens.js";
import type { ReplyPayload } from "../types.js";
import { hasLineDirectives, parseLineDirectives } from "./line-directives.js";
import {
  resolveResponsePrefixTemplate,
  type ResponsePrefixContext,
} from "./response-prefix-template.js";
import { hasSlackDirectives, parseSlackDirectives } from "./slack-directives.js";

export type NormalizeReplySkipReason = "empty" | "silent" | "heartbeat";

export type NormalizeReplyOptions = {
  responsePrefix?: string;
  enableSlackInteractiveReplies?: boolean;
  /** Context for template variable interpolation in responsePrefix */
  responsePrefixContext?: ResponsePrefixContext;
  onHeartbeatStrip?: () => void;
  stripHeartbeat?: boolean;
  silentToken?: string;
  onSkip?: (reason: NormalizeReplySkipReason) => void;
};

export function normalizeReplyPayload(
  payload: ReplyPayload,
  opts: NormalizeReplyOptions = {},
): ReplyPayload | null {
  const hasChannelData = hasReplyChannelData(payload.channelData);
  const trimmed = payload.text?.trim() ?? "";
  if (
    !hasReplyContent({
      text: trimmed,
      mediaUrl: payload.mediaUrl,
      mediaUrls: payload.mediaUrls,
      interactive: payload.interactive,
      hasChannelData,
    })
  ) {
    opts.onSkip?.("empty");
    return null;
  }

  const silentToken = opts.silentToken ?? SILENT_REPLY_TOKEN;
  let text = payload.text ?? undefined;
  if (text && isSilentReplyText(text, silentToken)) {
    if (
      !hasReplyContent({
        mediaUrl: payload.mediaUrl,
        mediaUrls: payload.mediaUrls,
        interactive: payload.interactive,
        hasChannelData,
      })
    ) {
      opts.onSkip?.("silent");
      return null;
    }
    text = "";
  }
  // Handle messages that contain NO_REPLY but aren't an exact match.
  // (#30916, #30955, #XXXXX)
  //
  // Two sub-cases:
  //
  // 1. Text-only (no media / interactive / channelData): the agent intended
  //    full silence. Any text preceding NO_REPLY is internal reasoning that
  //    must not be posted. Suppress the entire message.
  //
  // 2. Non-text content present (media, interactive, channelData): the agent
  //    wants to send the attachment/reaction but suppress the text portion
  //    (e.g. "😄 NO_REPLY" alongside a channel reaction). Strip the token
  //    from the text and let the non-text content through.
  if (text && text.includes(silentToken) && !isSilentReplyText(text, silentToken)) {
    const hasNonTextContent = hasReplyContent({
      mediaUrl: payload.mediaUrl,
      mediaUrls: payload.mediaUrls,
      interactive: payload.interactive,
      hasChannelData,
    });
    if (!hasNonTextContent) {
      // Text-only: suppress entirely — never post reasoning preamble.
      opts.onSkip?.("silent");
      return null;
    }
    // Non-text content exists: strip token from text, send other content.
    text = stripSilentToken(text, silentToken);
    if (
      !hasReplyContent({
        text,
        mediaUrl: payload.mediaUrl,
        mediaUrls: payload.mediaUrls,
        interactive: payload.interactive,
        hasChannelData,
      })
    ) {
      opts.onSkip?.("silent");
      return null;
    }
  }
  if (text && !trimmed) {
    // Keep empty text when media exists so media-only replies still send.
    text = "";
  }

  const shouldStripHeartbeat = opts.stripHeartbeat ?? true;
  if (shouldStripHeartbeat && text?.includes(HEARTBEAT_TOKEN)) {
    const stripped = stripHeartbeatToken(text, { mode: "message" });
    if (stripped.didStrip) {
      opts.onHeartbeatStrip?.();
    }
    if (
      stripped.shouldSkip &&
      !hasReplyContent({
        text: stripped.text,
        mediaUrl: payload.mediaUrl,
        mediaUrls: payload.mediaUrls,
        interactive: payload.interactive,
        hasChannelData,
      })
    ) {
      opts.onSkip?.("heartbeat");
      return null;
    }
    text = stripped.text;
  }

  if (text) {
    text = sanitizeUserFacingText(text, { errorContext: Boolean(payload.isError) });
  }
  if (
    !hasReplyContent({
      text,
      mediaUrl: payload.mediaUrl,
      mediaUrls: payload.mediaUrls,
      interactive: payload.interactive,
      hasChannelData,
    })
  ) {
    opts.onSkip?.("empty");
    return null;
  }

  // Parse LINE-specific directives from text (quick_replies, location, confirm, buttons)
  let enrichedPayload: ReplyPayload = { ...payload, text };
  if (text && hasLineDirectives(text)) {
    enrichedPayload = parseLineDirectives(enrichedPayload);
    text = enrichedPayload.text;
  }

  // Resolve template variables in responsePrefix if context is provided
  const effectivePrefix = opts.responsePrefixContext
    ? resolveResponsePrefixTemplate(opts.responsePrefix, opts.responsePrefixContext)
    : opts.responsePrefix;

  if (
    effectivePrefix &&
    text &&
    text.trim() !== HEARTBEAT_TOKEN &&
    !text.startsWith(effectivePrefix)
  ) {
    text = `${effectivePrefix} ${text}`;
  }

  enrichedPayload = { ...enrichedPayload, text };
  if (opts.enableSlackInteractiveReplies && text && hasSlackDirectives(text)) {
    enrichedPayload = parseSlackDirectives(enrichedPayload);
  }

  return enrichedPayload;
}
