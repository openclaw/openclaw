import { sanitizeUserFacingText } from "../../agents/pi-embedded-helpers.js";
import { hasReplyPayloadContent } from "../../interactive/payload.js";
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
import { compileSlackInteractiveReplies } from "./slack-directives.js";

export type NormalizeReplySkipReason = "empty" | "silent" | "heartbeat" | "internal_review";

export type NormalizeReplyOptions = {
  responsePrefix?: string;
  enableSlackInteractiveReplies?: boolean;
  applyChannelTransforms?: boolean;
  /** Context for template variable interpolation in responsePrefix */
  responsePrefixContext?: ResponsePrefixContext;
  onHeartbeatStrip?: () => void;
  stripHeartbeat?: boolean;
  silentToken?: string;
  onSkip?: (reason: NormalizeReplySkipReason) => void;
};

const INTERNAL_REVIEW_LEAK_PATTERNS = [
  /\bpaperclip_update_safe\b/i,
  /\bcan_finalize\b/i,
  /\bscope_or_logic_issues\b/i,
  /\brequired_revisions\b/i,
  /^\s*what still needs to be addressed\b/i,
  /^\s*i can'?t finalize this safely yet\b/i,
  /^\s*mình chưa thể chốt an toàn ở thời điểm này\b/i,
  /\buser-facing response\b/i,
  /\binternal-status artifact\b/i,
  /^\s*the draft\b/i,
  /^\s*the candidate\b/i,
  /^\s*candidate\b/i,
];

function looksLikeInternalReviewLeak(value: string): boolean {
  const normalized = value.trim();
  if (!normalized) {
    return false;
  }
  return INTERNAL_REVIEW_LEAK_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function normalizeReplyPayload(
  payload: ReplyPayload,
  opts: NormalizeReplyOptions = {},
): ReplyPayload | null {
  const applyChannelTransforms = opts.applyChannelTransforms ?? true;
  const hasContent = (text: string | undefined) =>
    hasReplyPayloadContent(
      {
        ...payload,
        text,
      },
      {
        trimText: true,
      },
    );
  const trimmed = payload.text?.trim() ?? "";
  if (!hasContent(trimmed)) {
    opts.onSkip?.("empty");
    return null;
  }

  const silentToken = opts.silentToken ?? SILENT_REPLY_TOKEN;
  let text = payload.text ?? undefined;
  if (text && isSilentReplyText(text, silentToken)) {
    if (!hasContent("")) {
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
    if (!hasContent(text)) {
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
    if (stripped.shouldSkip && !hasContent(stripped.text)) {
      opts.onSkip?.("heartbeat");
      return null;
    }
    text = stripped.text;
  }

  if (text) {
    text = sanitizeUserFacingText(text, { errorContext: Boolean(payload.isError) });
  }
  if (text && looksLikeInternalReviewLeak(text)) {
    opts.onSkip?.("internal_review");
    return null;
  }
  if (!hasContent(text)) {
    opts.onSkip?.("empty");
    return null;
  }

  // Parse LINE-specific directives from text (quick_replies, location, confirm, buttons)
  let enrichedPayload: ReplyPayload = { ...payload, text };
  if (applyChannelTransforms && text && hasLineDirectives(text)) {
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
  if (applyChannelTransforms && opts.enableSlackInteractiveReplies && text) {
    enrichedPayload = compileSlackInteractiveReplies(enrichedPayload);
  }

  return enrichedPayload;
}
