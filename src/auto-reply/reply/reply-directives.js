import { splitMediaFromOutput } from "../../media/parse.js";
import { parseInlineDirectives } from "../../utils/directive-tags.js";
import { isSilentReplyText, SILENT_REPLY_TOKEN } from "../tokens.js";
export function parseReplyDirectives(raw, options = {}) {
    const split = splitMediaFromOutput(raw);
    let text = split.text ?? "";
    const replyParsed = parseInlineDirectives(text, {
        currentMessageId: options.currentMessageId,
        stripAudioTag: false,
        stripReplyTags: true,
    });
    if (replyParsed.hasReplyTag) {
        text = replyParsed.text;
    }
    const silentToken = options.silentToken ?? SILENT_REPLY_TOKEN;
    const isSilent = isSilentReplyText(text, silentToken);
    if (isSilent) {
        text = "";
    }
    return {
        text,
        mediaUrls: split.mediaUrls,
        mediaUrl: split.mediaUrl,
        replyToId: replyParsed.replyToId,
        replyToCurrent: replyParsed.replyToCurrent,
        replyToTag: replyParsed.hasReplyTag,
        audioAsVoice: split.audioAsVoice,
        isSilent,
    };
}
