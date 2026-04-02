import { estimateUtf8Bytes, splitTextToUtf8ByteLimit } from "./embedding-input-limits.js";
import { hasNonTextEmbeddingParts } from "./embedding-inputs.js";
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
    if (hasNonTextEmbeddingParts(chunk.embeddingInput)) {
      out.push(chunk);
      continue;
    }
    if (estimateUtf8Bytes(chunk.text) <= maxInputTokens) {
      out.push(chunk);
      continue;
    }

    const hasOffset = "startOffset" in chunk && "endOffset" in chunk;
    let offsetCursor = hasOffset ? (chunk as { startOffset: number }).startOffset : 0;
    for (const text of splitTextToUtf8ByteLimit(chunk.text, maxInputTokens)) {
      const splitChunk: MemoryChunk = {
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        text,
        hash: hashText(text),
        embeddingInput: { text },
      };
      if (hasOffset) {
        (splitChunk as MemoryChunk & { startOffset: number; endOffset: number }).startOffset =
          offsetCursor;
        (splitChunk as MemoryChunk & { startOffset: number; endOffset: number }).endOffset =
          offsetCursor + text.length - 1;
      }
      offsetCursor += text.length;
      out.push(splitChunk);
    }
  }

  return out;
}
