import { estimateUtf8Bytes, splitTextToUtf8ByteLimit } from "./embedding-input-limits.js";
import { resolveEmbeddingMaxInputTokens } from "./embedding-model-limits.js";
import type { EmbeddingProvider } from "./embeddings.js";
import { hashText, type MemoryChunk } from "./internal.js";

export function enforceEmbeddingMaxInputTokens(
  provider: EmbeddingProvider,
  chunks: MemoryChunk[],
  hardMaxInputTokens?: number,
): MemoryChunk[] {
  const providerMaxInputTokens = resolveEmbeddingMaxInputTokens(provider);
  const maxInputTokens =
    typeof hardMaxInputTokens === "number" && hardMaxInputTokens > 0
      ? Math.min(providerMaxInputTokens, hardMaxInputTokens)
      : providerMaxInputTokens;
  const out: MemoryChunk[] = [];

  for (const chunk of chunks) {
    const effectiveText = chunk.embedText ?? chunk.text;
    if (estimateUtf8Bytes(effectiveText) <= maxInputTokens) {
      out.push(chunk);
      continue;
    }

    // When splitting an over-limit chunk, split based on the embedding text
    // but keep text/embedText aligned so cache keys stay correct.
    if (chunk.embedText) {
      const splitEmbedTexts = splitTextToUtf8ByteLimit(chunk.embedText, maxInputTokens);
      // Align text splits to embedText splits: compute the title prefix length
      // and distribute chunk.text across the same number of output chunks.
      const prefixLen = chunk.embedText.length - chunk.text.length;
      const splitTexts = splitTextToUtf8ByteLimit(chunk.text, maxInputTokens);

      // If counts match, use 1:1 mapping. Otherwise, distribute text splits
      // across embedText splits to maintain alignment.
      if (splitTexts.length === splitEmbedTexts.length) {
        for (let i = 0; i < splitEmbedTexts.length; i++) {
          out.push({
            startLine: chunk.startLine,
            endLine: chunk.endLine,
            text: splitTexts[i],
            embedText: splitEmbedTexts[i],
            hash: hashText(splitEmbedTexts[i]),
          });
        }
      } else {
        // Counts differ due to prefix; re-split text to match embedText count
        const adjustedLimit = Math.max(128, maxInputTokens - Math.max(0, prefixLen));
        const reSplitTexts = splitTextToUtf8ByteLimit(chunk.text, adjustedLimit);
        for (let i = 0; i < splitEmbedTexts.length; i++) {
          out.push({
            startLine: chunk.startLine,
            endLine: chunk.endLine,
            text: reSplitTexts[i] ?? splitEmbedTexts[i],
            embedText: splitEmbedTexts[i],
            hash: hashText(splitEmbedTexts[i]),
          });
        }
      }
    } else {
      for (const text of splitTextToUtf8ByteLimit(chunk.text, maxInputTokens)) {
        out.push({
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          text,
          hash: hashText(text),
        });
      }
    }
  }

  return out;
}
