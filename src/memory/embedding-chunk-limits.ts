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
      const splitTexts = splitTextToUtf8ByteLimit(chunk.text, maxInputTokens);
      for (let i = 0; i < splitEmbedTexts.length; i++) {
        const embedText = splitEmbedTexts[i];
        out.push({
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          text: splitTexts[i] ?? embedText,
          embedText,
          hash: hashText(embedText),
        });
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
