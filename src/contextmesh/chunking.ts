export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.trim().length / 4));
}

export type ChunkTextOptions = {
  maxChunkTokens: number;
  overlapTokens: number;
};

export type ChunkedText = {
  id: string;
  text: string;
  estimatedTokens: number;
};

export function chunkText(input: string, options: ChunkTextOptions): ChunkedText[] {
  const words = input.split(/\s+/).filter(Boolean);
  const targetWords = Math.max(50, Math.floor(options.maxChunkTokens / 1.3));
  const overlapWords = Math.max(0, Math.floor(options.overlapTokens / 1.3));
  const chunks: ChunkedText[] = [];
  let cursor = 0;
  let index = 0;
  while (cursor < words.length) {
    const end = Math.min(words.length, cursor + targetWords);
    const slice = words.slice(cursor, end).join(" ");
    chunks.push({
      id: `chunk-${index + 1}`,
      text: slice,
      estimatedTokens: estimateTokens(slice),
    });
    if (end >= words.length) {
      break;
    }
    cursor = Math.max(cursor + 1, end - overlapWords);
    index += 1;
  }
  return chunks;
}
