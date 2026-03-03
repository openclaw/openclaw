import { sanitizeUserFacingText } from "../../agents/pi-embedded-helpers.js";
import { stripHeartbeatToken } from "../heartbeat.js";
import { HEARTBEAT_TOKEN, isSilentReplyText, SILENT_REPLY_TOKEN, stripSilentToken, } from "../tokens.js";
import { hasLineDirectives, parseLineDirectives } from "./line-directives.js";
import { resolveResponsePrefixTemplate, } from "./response-prefix-template.js";
export function normalizeReplyPayload(payload, opts = {}) {
    const hasMedia = Boolean(payload.mediaUrl || (payload.mediaUrls?.length ?? 0) > 0);
    const hasChannelData = Boolean(payload.channelData && Object.keys(payload.channelData).length > 0);
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
    // Strip NO_REPLY from mixed-content messages (e.g. "😄 NO_REPLY") so the
    // token never leaks to end users.  If stripping leaves nothing, treat it as
    // silent just like the exact-match path above.  (#30916, #30955)
    if (text && text.includes(silentToken) && !isSilentReplyText(text, silentToken)) {
        text = stripSilentToken(text, silentToken);
        if (!text && !hasMedia && !hasChannelData) {
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
        if (stripped.shouldSkip && !hasMedia && !hasChannelData) {
            opts.onSkip?.("heartbeat");
            return null;
        }
        text = stripped.text;
    }
    if (text) {
        text = sanitizeUserFacingText(text, { errorContext: Boolean(payload.isError) });
    }
    if (!text?.trim() && !hasMedia && !hasChannelData) {
        opts.onSkip?.("empty");
        return null;
    }
    // Parse LINE-specific directives from text (quick_replies, location, confirm, buttons)
    let enrichedPayload = { ...payload, text };
    if (text && hasLineDirectives(text)) {
        enrichedPayload = parseLineDirectives(enrichedPayload);
        text = enrichedPayload.text;
    }
    // Resolve template variables in responsePrefix if context is provided
    const effectivePrefix = opts.responsePrefixContext
        ? resolveResponsePrefixTemplate(opts.responsePrefix, opts.responsePrefixContext)
        : opts.responsePrefix;
    if (effectivePrefix &&
        text &&
        text.trim() !== HEARTBEAT_TOKEN &&
        !text.startsWith(effectivePrefix)) {
        text = `${effectivePrefix} ${text}`;
    }
    return { ...enrichedPayload, text };
}
