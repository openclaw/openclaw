import { sanitizeUserFacingText } from "../../agents/pi-embedded-helpers.js";
import { hasReplyPayloadContent } from "../../interactive/payload.js";
import { stripHeartbeatToken } from "../heartbeat.js";
import {
  ANNOUNCE_SKIP_TOKEN,
  HEARTBEAT_TOKEN,
  isSilentReplyText,
  REPLY_SKIP_TOKEN,
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

export type NormalizeReplySkipReason = "empty" | "silent" | "heartbeat";

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
  // Suppress agent-to-agent conversation stop tokens (ANNOUNCE_SKIP, REPLY_SKIP).
  // These are internal protocol tokens the main session returns to opt out of
  // rebroadcasting a subagent announce summary or ending a ping-pong exchange.
  // They must never reach the end-user channel, matching the NO_REPLY contract.
  //
  // Unlike NO_REPLY, mixed-content trailing stripping is intentionally NOT
  // applied here.  These tokens are only emitted as the sole content in the
  // internal protocol (the model is instructed to return them in isolation),
  // so "Task done. ANNOUNCE_SKIP" is not a valid output pattern and does not
  // need a stripping path — treating it as opaque text is the safer default.
  if (
    text &&
    (isSilentReplyText(text, ANNOUNCE_SKIP_TOKEN) || isSilentReplyText(text, REPLY_SKIP_TOKEN))
  ) {
    if (!hasMedia && !hasChannelData) {
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
