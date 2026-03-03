const AUDIO_TAG_RE = /\[\[\s*audio_as_voice\s*\]\]/gi;
const REPLY_TAG_RE = /\[\[\s*(?:reply_to_current|reply_to\s*:\s*([^\]\n]+))\s*\]\]/gi;
function normalizeDirectiveWhitespace(text) {
    return text
        .replace(/[ \t]+/g, " ")
        .replace(/[ \t]*\n[ \t]*/g, "\n")
        .trim();
}
export function stripInlineDirectiveTagsForDisplay(text) {
    if (!text) {
        return { text, changed: false };
    }
    const withoutAudio = text.replace(AUDIO_TAG_RE, "");
    const stripped = withoutAudio.replace(REPLY_TAG_RE, "");
    return {
        text: stripped,
        changed: stripped !== text,
    };
}
function isMessageTextPart(part) {
    return Boolean(part) && part?.type === "text" && typeof part.text === "string";
}
/**
 * Strips inline directive tags from message text blocks while preserving message shape.
 * Empty post-strip text stays empty-string to preserve caller semantics.
 */
export function stripInlineDirectiveTagsFromMessageForDisplay(message) {
    if (!message) {
        return message;
    }
    if (!Array.isArray(message.content)) {
        return message;
    }
    const cleaned = message.content.map((part) => {
        if (!part || typeof part !== "object") {
            return part;
        }
        const record = part;
        if (!isMessageTextPart(record)) {
            return part;
        }
        return { ...record, text: stripInlineDirectiveTagsForDisplay(record.text).text };
    });
    return { ...message, content: cleaned };
}
export function parseInlineDirectives(text, options = {}) {
    const { currentMessageId, stripAudioTag = true, stripReplyTags = true } = options;
    if (!text) {
        return {
            text: "",
            audioAsVoice: false,
            replyToCurrent: false,
            hasAudioTag: false,
            hasReplyTag: false,
        };
    }
    let cleaned = text;
    let audioAsVoice = false;
    let hasAudioTag = false;
    let hasReplyTag = false;
    let sawCurrent = false;
    let lastExplicitId;
    cleaned = cleaned.replace(AUDIO_TAG_RE, (match) => {
        audioAsVoice = true;
        hasAudioTag = true;
        return stripAudioTag ? " " : match;
    });
    cleaned = cleaned.replace(REPLY_TAG_RE, (match, idRaw) => {
        hasReplyTag = true;
        if (idRaw === undefined) {
            sawCurrent = true;
        }
        else {
            const id = idRaw.trim();
            if (id) {
                lastExplicitId = id;
            }
        }
        return stripReplyTags ? " " : match;
    });
    cleaned = normalizeDirectiveWhitespace(cleaned);
    const replyToId = lastExplicitId ?? (sawCurrent ? currentMessageId?.trim() || undefined : undefined);
    return {
        text: cleaned,
        audioAsVoice,
        replyToId,
        replyToExplicitId: lastExplicitId,
        replyToCurrent: sawCurrent,
        hasAudioTag,
        hasReplyTag,
    };
}
