import { redactInternalDetails } from "../../agents/pi-embedded-helpers/errors.js";
import { sanitizeUserFacingText } from "../../agents/pi-embedded-helpers/sanitize-user-facing-text.js";
import { hasReplyPayloadContent } from "../../interactive/payload.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { stripHeartbeatToken } from "../heartbeat.js";
import {
  HEARTBEAT_TOKEN,
  isSilentReplyPayloadText,
  isSilentReplyText,
  SILENT_REPLY_TOKEN,
  startsWithSilentToken,
  stripLeadingSilentToken,
  stripSilentToken,
} from "../tokens.js";
import type { ReplyPayload } from "../types.js";
import {
  resolveResponsePrefixTemplate,
  type ResponsePrefixContext,
} from "./response-prefix-template.js";

export type NormalizeReplySkipReason = "empty" | "silent" | "heartbeat";

export type NormalizeReplyOptions = {
  responsePrefix?: string;
  applyChannelTransforms?: boolean;
  /** Context for template variable interpolation in responsePrefix */
  responsePrefixContext?: ResponsePrefixContext;
  onHeartbeatStrip?: () => void;
  stripHeartbeat?: boolean;
  silentToken?: string;
  transformReplyPayload?: (payload: ReplyPayload) => ReplyPayload | null;
  /** shoar local: When true, redact file paths, session keys, and model/provider details from output. */
  redactInternals?: boolean;
  onSkip?: (reason: NormalizeReplySkipReason) => void;
};

function shouldSuppressSilentReasoningText(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) {
    return true;
  }
  if (/^[\p{Extended_Pictographic}\s]+$/u.test(text)) {
    return false;
  }
  const exactMarkers = [
    /\bnot for me\b/,
    /\bnot addressed to me\b/,
    /\bthis isn't addressed to me\b/,
    /\blet it breathe\b/,
    /\bstay quiet\b/,
    /\bgoing quiet\b/,
    /\bi(?:'m| am)\s+(?:going|staying)\s+quiet\b/,
    /\bwait and watch\b/,
    /\bwatch and wait\b/,
    /\bprobably no need\b/,
    /\blikely no need\b/,
    /\bthat's for (?:shoar|brodie|them|him|her)\b/,
  ];
  if (exactMarkers.some((pattern) => pattern.test(normalized))) {
    return true;
  }
  const words = normalized.split(/\s+/).filter(Boolean);
  return (
    words.length >= 10 &&
    /\b(i|me|my)\b/.test(normalized) &&
    /\b(should|could|probably|likely|need|reply|respond|quiet|watch|breathe|addressed)\b/.test(
      normalized,
    )
  );
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
  const trimmed = normalizeOptionalString(payload.text) ?? "";
  if (!hasContent(trimmed)) {
    opts.onSkip?.("empty");
    return null;
  }

  const silentToken = opts.silentToken ?? SILENT_REPLY_TOKEN;
  let text = payload.text ?? undefined;
  if (text && isSilentReplyPayloadText(text, silentToken)) {
    if (!hasContent("")) {
      opts.onSkip?.("silent");
      return null;
    }
    text = "";
  }
  // Strip NO_REPLY from mixed-content messages (e.g. "😄 NO_REPLY") so the
  // token never leaks to end users.  If stripping leaves nothing, treat it as
  // silent just like the exact-match path above.  (#30916, #30955)
  if (text && !isSilentReplyText(text, silentToken)) {
    const hasLeadingSilentToken = startsWithSilentToken(text, silentToken);
    if (hasLeadingSilentToken) {
      text = stripLeadingSilentToken(text, silentToken);
    }
    if (hasLeadingSilentToken || text.toLowerCase().includes(silentToken.toLowerCase())) {
      const stripped = stripSilentToken(text, silentToken);
      if (stripped !== text && shouldSuppressSilentReasoningText(stripped)) {
        opts.onSkip?.("silent");
        return null;
      }
      text = stripped;
      if (!hasContent(text)) {
        opts.onSkip?.("silent");
        return null;
      }
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
    if (opts.redactInternals) {
      text = redactInternalDetails(text);
    }
  }
  if (!hasContent(text)) {
    opts.onSkip?.("empty");
    return null;
  }

  let enrichedPayload: ReplyPayload = { ...payload, text };
  if (applyChannelTransforms && opts.transformReplyPayload) {
    enrichedPayload = opts.transformReplyPayload(enrichedPayload) ?? enrichedPayload;
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
  return enrichedPayload;
}
