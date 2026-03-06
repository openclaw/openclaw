import { sanitizeUserFacingText } from "../../agents/pi-embedded-helpers.js";
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

export type NormalizeReplySkipReason = "empty" | "silent" | "heartbeat";

export type NormalizeReplyOptions = {
  responsePrefix?: string;
  /** Context for template variable interpolation in responsePrefix */
  responsePrefixContext?: ResponsePrefixContext;
  onHeartbeatStrip?: () => void;
  stripHeartbeat?: boolean;
  silentToken?: string;
  onSkip?: (reason: NormalizeReplySkipReason) => void;
};

function isNoReplyActionValue(value: unknown): boolean {
  return typeof value === "string" && value.trim().toUpperCase() === SILENT_REPLY_TOKEN;
}

function parseNoReplyActionJsonText(text: string | undefined): boolean {
  const trimmed = text?.trim();
  if (!trimmed || !trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return false;
  }
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    return isNoReplyActionValue(parsed.action);
  } catch {
    return false;
  }
}

function containsNoReplyAction(value: unknown): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some((entry) => containsNoReplyAction(entry));
  }
  const record = value as Record<string, unknown>;
  if (isNoReplyActionValue(record.action)) {
    return true;
  }
  return Object.values(record).some((entry) => containsNoReplyAction(entry));
}

export function normalizeReplyPayload(
  payload: ReplyPayload,
  opts: NormalizeReplyOptions = {},
): ReplyPayload | null {
  const hasMedia = Boolean(payload.mediaUrl || (payload.mediaUrls?.length ?? 0) > 0);
  const hasChannelData = Boolean(
    payload.channelData && Object.keys(payload.channelData).length > 0,
  );
  const hasNoReplyActionChannelData = containsNoReplyAction(payload.channelData);
  const textIsNoReplyActionJson = parseNoReplyActionJsonText(payload.text);
  const trimmed = payload.text?.trim() ?? "";
  const hasEffectiveChannelData = hasChannelData && !hasNoReplyActionChannelData;

  if ((textIsNoReplyActionJson || hasNoReplyActionChannelData) && !hasMedia && !trimmed) {
    opts.onSkip?.("silent");
    return null;
  }
  if (textIsNoReplyActionJson && !hasMedia && !hasEffectiveChannelData) {
    opts.onSkip?.("silent");
    return null;
  }

  if (!trimmed && !hasMedia && !hasEffectiveChannelData) {
    opts.onSkip?.("empty");
    return null;
  }

  const silentToken = opts.silentToken ?? SILENT_REPLY_TOKEN;
  let text = payload.text ?? undefined;
  if (text && isSilentReplyText(text, silentToken)) {
    if (!hasMedia && !hasEffectiveChannelData) {
      opts.onSkip?.("silent");
      return null;
    }
    text = "";
  }
  // Strip NO_REPLY from mixed-content messages (e.g. "😄 NO_REPLY") so the
  // token never leaks to end users.  If stripping leaves nothing, treat it as
  // silent just like the exact-match path above.  (#30916, #30955)
  if (text && text.includes(silentToken) && !isSilentReplyText(text, silentToken)) {
    text = stripSilentToken(text, silentToken);
    if (!text && !hasMedia && !hasEffectiveChannelData) {
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
    if (stripped.shouldSkip && !hasMedia && !hasEffectiveChannelData) {
      opts.onSkip?.("heartbeat");
      return null;
    }
    text = stripped.text;
  }

  if (text) {
    text = sanitizeUserFacingText(text, { errorContext: Boolean(payload.isError) });
  }
  if (!text?.trim() && !hasMedia && !hasEffectiveChannelData) {
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

  return { ...enrichedPayload, text };
}
