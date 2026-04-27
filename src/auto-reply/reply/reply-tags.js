import { parseInlineDirectives } from "../../utils/directive-tags.js";
export function extractReplyToTag(text, currentMessageId) {
    const result = parseInlineDirectives(text, {
        currentMessageId,
        stripAudioTag: false,
    });
    return {
        cleaned: result.text,
        replyToId: result.replyToId,
        replyToCurrent: result.replyToCurrent,
        hasTag: result.hasReplyTag,
    };
}
