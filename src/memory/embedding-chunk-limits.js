import { estimateUtf8Bytes, splitTextToUtf8ByteLimit } from "./embedding-input-limits.js";
import { resolveEmbeddingMaxInputTokens } from "./embedding-model-limits.js";
import { hashText } from "./internal.js";
export function enforceEmbeddingMaxInputTokens(provider, chunks, hardMaxInputTokens) {
    const providerMaxInputTokens = resolveEmbeddingMaxInputTokens(provider);
    const maxInputTokens = typeof hardMaxInputTokens === "number" && hardMaxInputTokens > 0
        ? Math.min(providerMaxInputTokens, hardMaxInputTokens)
        : providerMaxInputTokens;
    const out = [];
    for (const chunk of chunks) {
        if (estimateUtf8Bytes(chunk.text) <= maxInputTokens) {
            out.push(chunk);
            continue;
        }
        for (const text of splitTextToUtf8ByteLimit(chunk.text, maxInputTokens)) {
            out.push({
                startLine: chunk.startLine,
                endLine: chunk.endLine,
                text,
                hash: hashText(text),
            });
        }
    }
    return out;
}
