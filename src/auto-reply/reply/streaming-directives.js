import { splitMediaFromOutput } from "../../media/parse.js";
import { parseInlineDirectives } from "../../utils/directive-tags.js";
import { isSilentReplyPrefixText, isSilentReplyText, SILENT_REPLY_TOKEN } from "../tokens.js";
const splitTrailingDirective = (text) => {
    const openIndex = text.lastIndexOf("[[");
    if (openIndex < 0) {
        return { text, tail: "" };
    }
    const closeIndex = text.indexOf("]]", openIndex + 2);
    if (closeIndex >= 0) {
        return { text, tail: "" };
    }
    return {
        text: text.slice(0, openIndex),
        tail: text.slice(openIndex),
    };
};
const parseChunk = (raw, options) => {
    const split = splitMediaFromOutput(raw);
    let text = split.text ?? "";
    const replyParsed = parseInlineDirectives(text, {
        stripAudioTag: false,
        stripReplyTags: true,
    });
    if (replyParsed.hasReplyTag) {
        text = replyParsed.text;
    }
    const silentToken = options?.silentToken ?? SILENT_REPLY_TOKEN;
    const isSilent = isSilentReplyText(text, silentToken) || isSilentReplyPrefixText(text, silentToken);
    if (isSilent) {
        text = "";
    }
    return {
        text,
        mediaUrls: split.mediaUrls,
        mediaUrl: split.mediaUrl,
        replyToId: replyParsed.replyToId,
        replyToExplicitId: replyParsed.replyToExplicitId,
        replyToCurrent: replyParsed.replyToCurrent,
        replyToTag: replyParsed.hasReplyTag,
        audioAsVoice: split.audioAsVoice,
        isSilent,
    };
};
const hasRenderableContent = (parsed) => Boolean(parsed.text) ||
    Boolean(parsed.mediaUrl) ||
    (parsed.mediaUrls?.length ?? 0) > 0 ||
    Boolean(parsed.audioAsVoice);
export function createStreamingDirectiveAccumulator() {
    let pendingTail = "";
    let pendingReply = { sawCurrent: false, hasTag: false };
    let activeReply = { sawCurrent: false, hasTag: false };
    const reset = () => {
        pendingTail = "";
        pendingReply = { sawCurrent: false, hasTag: false };
        activeReply = { sawCurrent: false, hasTag: false };
    };
    const consume = (raw, options = {}) => {
        let combined = `${pendingTail}${raw ?? ""}`;
        pendingTail = "";
        if (!options.final) {
            const split = splitTrailingDirective(combined);
            combined = split.text;
            pendingTail = split.tail;
        }
        if (!combined) {
            return null;
        }
        const parsed = parseChunk(combined, { silentToken: options.silentToken });
        const hasTag = activeReply.hasTag || pendingReply.hasTag || parsed.replyToTag;
        const sawCurrent = activeReply.sawCurrent || pendingReply.sawCurrent || parsed.replyToCurrent;
        const explicitId = parsed.replyToExplicitId ?? pendingReply.explicitId ?? activeReply.explicitId;
        const combinedResult = {
            ...parsed,
            replyToId: explicitId,
            replyToCurrent: sawCurrent,
            replyToTag: hasTag,
        };
        if (!hasRenderableContent(combinedResult)) {
            if (hasTag) {
                pendingReply = {
                    explicitId,
                    sawCurrent,
                    hasTag,
                };
            }
            return null;
        }
        // Keep reply context sticky for the full assistant message so split/newline chunks
        // stay on the same native reply target until reset() is called for the next message.
        activeReply = {
            explicitId,
            sawCurrent,
            hasTag,
        };
        pendingReply = { sawCurrent: false, hasTag: false };
        return combinedResult;
    };
    return {
        consume,
        reset,
    };
}
