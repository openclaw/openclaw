import { chunkByParagraph, chunkMarkdownTextWithMode, } from "../../auto-reply/chunk.js";
function withPlannedReplyTo(overrides, consumeReplyTo) {
    return consumeReplyTo ? consumeReplyTo({ ...overrides }) : { ...overrides };
}
function chunkTextForPlan(params) {
    return params.formatting
        ? params.chunker(params.text, params.limit, { formatting: params.formatting })
        : params.chunker(params.text, params.limit);
}
export function planOutboundTextMessageUnits(params) {
    const planTextUnit = (text) => ({
        kind: "text",
        text,
        overrides: withPlannedReplyTo(params.overrides, params.consumeReplyTo),
    });
    if (!params.chunker || params.textLimit === undefined) {
        return [planTextUnit(params.text)];
    }
    if (params.chunkMode === "newline") {
        const blockChunks = (params.chunkerMode ?? "text") === "markdown"
            ? chunkMarkdownTextWithMode(params.text, params.textLimit, "newline")
            : chunkByParagraph(params.text, params.textLimit);
        if (!blockChunks.length && params.text) {
            blockChunks.push(params.text);
        }
        const units = [];
        for (const blockChunk of blockChunks) {
            const chunks = chunkTextForPlan({
                text: blockChunk,
                limit: params.textLimit,
                chunker: params.chunker,
                formatting: params.formatting,
            });
            if (!chunks.length && blockChunk) {
                chunks.push(blockChunk);
            }
            for (const chunk of chunks) {
                units.push(planTextUnit(chunk));
            }
        }
        return units;
    }
    return chunkTextForPlan({
        text: params.text,
        limit: params.textLimit,
        chunker: params.chunker,
        formatting: params.formatting,
    }).map(planTextUnit);
}
export function planOutboundMediaMessageUnits(params) {
    return params.mediaUrls.map((mediaUrl, index) => ({
        kind: "media",
        mediaUrl,
        ...(index === 0 ? { caption: params.caption } : {}),
        overrides: withPlannedReplyTo(params.overrides, params.consumeReplyTo),
    }));
}
