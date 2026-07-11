// Normalizes raw agent output into sendable reply text and metadata.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { sanitizeUserFacingText } from "../../agents/embedded-agent-helpers/sanitize-user-facing-text.js";
import { hasReplyPayloadContent } from "../../interactive/payload.js";
import { escapeRegExp } from "../../shared/regexp.js";
import { stripHeartbeatToken } from "../heartbeat.js";
import { copyReplyPayloadMetadata } from "../reply-payload.js";
import {
  HEARTBEAT_TOKEN,
  isInternalFormattingArtifact,
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

type NormalizeReplyOptions = {
  responsePrefix?: string;
  applyChannelTransforms?: boolean;
  /** Context for template variable interpolation in responsePrefix */
  responsePrefixContext?: ResponsePrefixContext;
  onHeartbeatStrip?: () => void;
  stripHeartbeat?: boolean;
  silentToken?: string;
  transformReplyPayload?: (payload: ReplyPayload) => ReplyPayload | null;
  onSkip?: (reason: NormalizeReplySkipReason) => void;
};

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
  // token never leaks to end users. If stripping leaves nothing, treat it as
  // silent just like the exact-match path above. (#30916, #30955)
  //
  // Also strip a leading token that is separated by newlines
  // (e.g. "NO_REPLY\n\nWait..."). The startsWithSilentToken check only matches
  // when the token is glued directly to the following text, leaving the
  // newline-separated case to fall through. Detect this case by checking if
  // the text starts with the token followed by a newline, then strip it.
  // See: https://github.com/openclaw/openclaw/issues/103735
  if (text && !isSilentReplyText(text, silentToken)) {
    const hasLeadingSilentToken = startsWithSilentToken(text, silentToken);
    // Detect newline-separated leading tokens: "NO_REPLY\n\nWait..." or "NO_REPLY\nWait..."
    // The token must be at the start, followed by a newline, then content.
    // When the token is newline-separated, the interstitial reasoning paragraph
    // between the token and the actual reply must also be stripped — removing
    // only the token would still expose the reasoning to end users.
    const escapedToken = escapeRegExp(silentToken);
    const newlineSeparatedMatch = text.match(
      new RegExp(`^\\s*${escapedToken}\\s*\\r?\\n([\\s\\S]*?)(?:\\n\\s*\\n|[\\s\\S]*$)`, "i"),
    );
    if (newlineSeparatedMatch) {
      // The token was separated by a newline; strip the token + interstitial
      // reasoning paragraph (everything up to the first blank line, which is
      // where the actual user-facing reply typically starts).
      const afterBlankLine = text.match(
        new RegExp(`^\\s*${escapedToken}\\s*\\r?\\n[\\s\\S]*?\\n\\s*\\n([\\s\\S]*)$`, "i"),
      );
      text = afterBlankLine ? afterBlankLine[1].trimStart() : "";
    } else if (hasLeadingSilentToken) {
      text = stripLeadingSilentToken(text, silentToken);
    }
    const hasLeadingToken = hasLeadingSilentToken || Boolean(newlineSeparatedMatch);
    if (hasLeadingToken || text.toLowerCase().includes(silentToken.toLowerCase())) {
      text = stripSilentToken(text, silentToken);
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

  if (text && isInternalFormattingArtifact(text) && !hasContent("")) {
    opts.onSkip?.("silent");
    return null;
  }

  if (text) {
    text = sanitizeUserFacingText(text, { errorContext: Boolean(payload.isError) });
  }
  if (!hasContent(text)) {
    opts.onSkip?.("empty");
    return null;
  }

  let enrichedPayload: ReplyPayload = copyReplyPayloadMetadata(payload, { ...payload, text });
  if (applyChannelTransforms && opts.transformReplyPayload) {
    const transformedPayload = opts.transformReplyPayload(enrichedPayload);
    if (transformedPayload === null) {
      return null;
    }
    enrichedPayload = transformedPayload
      ? copyReplyPayloadMetadata(enrichedPayload, transformedPayload)
      : enrichedPayload;
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

  enrichedPayload = copyReplyPayloadMetadata(enrichedPayload, { ...enrichedPayload, text });
  return enrichedPayload;
}
