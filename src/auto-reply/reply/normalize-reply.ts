import type { ReplyPayload } from "../types.js";
import { sanitizeUserFacingText } from "../../agents/pi-embedded-helpers.js";
import { emitSecurityEvent } from "../../security/event-logger.js";
import { applyOutputCsp, type OutputCspRuleId } from "../../security/output-policy.js";
import { stripHeartbeatToken } from "../heartbeat.js";
import { HEARTBEAT_TOKEN, isSilentReplyText, SILENT_REPLY_TOKEN } from "../tokens.js";
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
  /** Pre-resolved CSP rules for this channel (caller resolves from config). */
  outputCspRules?: OutputCspRuleId[];
  /** Channel identifier for CSP security event emission. */
  outputCspChannel?: string;
  /** Session key for CSP security event emission. */
  outputCspSessionKey?: string;
};

export function normalizeReplyPayload(
  payload: ReplyPayload,
  opts: NormalizeReplyOptions = {},
): ReplyPayload | null {
  const hasMedia = Boolean(payload.mediaUrl || (payload.mediaUrls?.length ?? 0) > 0);
  const hasChannelData = Boolean(
    payload.channelData && Object.keys(payload.channelData).length > 0,
  );
  const trimmed = payload.text?.trim() ?? "";
  if (!trimmed && !hasMedia && !hasChannelData) {
    opts.onSkip?.("empty");
    return null;
  }

  const silentToken = opts.silentToken ?? SILENT_REPLY_TOKEN;
  let text = payload.text ?? undefined;
  if (text && isSilentReplyText(text, silentToken)) {
    if (!hasMedia && !hasChannelData) {
      opts.onSkip?.("silent");
      return null;
    }
    text = "";
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
    if (stripped.shouldSkip && !hasMedia && !hasChannelData) {
      opts.onSkip?.("heartbeat");
      return null;
    }
    text = stripped.text;
  }

  if (text) {
    text = sanitizeUserFacingText(text, { errorContext: Boolean(payload.isError) });
  }

  // Apply output CSP rules before chunking and LINE directives
  if (text && opts.outputCspRules && opts.outputCspRules.length > 0) {
    const cspResult = applyOutputCsp(text, opts.outputCspRules);
    if (cspResult.strippedRules.length > 0) {
      for (const stripped of cspResult.strippedRules) {
        emitSecurityEvent({
          eventType: "output.csp.stripped",
          timestamp: new Date().toISOString(),
          severity: "warn",
          channel: opts.outputCspChannel,
          sessionKey: opts.outputCspSessionKey,
          action: "redacted",
          detail: `Rule ${stripped.ruleId} matched ${stripped.matches.length} pattern(s)`,
          meta: {
            ruleId: stripped.ruleId,
            matchCount: stripped.matches.length,
            originalMatches: stripped.matches.slice(0, 5),
          },
        });
      }
      text = cspResult.text;
    }
  }

  if (!text?.trim() && !hasMedia && !hasChannelData) {
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
