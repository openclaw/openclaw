import { cosineSimilarity } from "../internal.js";
import type { MemoryChunk } from "../internal.js";
import { hashText } from "./hash.js";
import type { ChunkingStrategy, ChunkingConfig } from "./types.js";
import { type EmbeddingProvider } from "../embeddings.js";
import { buildTextEmbeddingInput } from "../embedding-inputs.js";
import { splitIntoSentences } from "./sentence.js";

/** Default buffer size for combining sentences. */
export const DEFAULT_BUFFER_SIZE = 1;

/** Default breakpoint percentile threshold. */
export const DEFAULT_BREAKPOINT_PERCENTILE_THRESHOLD = 95;

type SentenceWithEmbedding = {
  text: string;
  startLine: number; // 1-indexed
  endLine: number; // 1-indexed
  chars: number; // estimated chars (CJK-aware)
  dist_to_next?: number;
  embedding?: number[];
  combined_text?: string;
};

/**
 * Combine adjacent sentences using a sliding window of `bufferSize` on each side.
 * Each entry's `combined_text` is the concatenation of [i-bufferSize .. i+bufferSize].
 */
function combineSentences(
  sentences: SentenceWithEmbedding[],
  bufferSize: number,
): SentenceWithEmbedding[] {
  return sentences.map((entry, i) => {
    const start = Math.max(0, i - bufferSize);
    const end = Math.min(sentences.length - 1, i + bufferSize);
    const combined = sentences
      .slice(start, end + 1)
      .map((s) => s.text)
      .join(" ");
    return { ...entry, combined_text: combined };
  });
}

/**
 * Calculate cosine *distance* (1 - similarity) between each adjacent pair of embeddings.
 * Returns an array of length `sentences.length - 1`.
 */
function calculateCosineDistances(sentences: SentenceWithEmbedding[]): number[] {
  const distances: number[] = [];
  for (let i = 0; i < sentences.length - 1; i += 1) {
    const a = sentences[i]?.embedding ?? [];
    const b = sentences[i + 1]?.embedding ?? [];
    distances.push(1 - cosineSimilarity(a, b));
  }
  return distances;
}

/**
 * Return indices (into the distances array) whose value exceeds the given
 * percentile threshold over all distances.  These become semantic break-points.
 */
function getIndicesAboveThreshold(
  distances: number[],
  breakpointPercentileThreshold: number,
): number[] {
  if (distances.length === 0) {
    return [];
  }
  const sorted = [...distances].toSorted((a, b) => a - b);
  const thresholdIdx = Math.floor((breakpointPercentileThreshold / 100) * sorted.length);
  const threshold = sorted[Math.min(thresholdIdx, sorted.length - 1)] ?? 0;
  return distances.reduce<number[]>((acc, d, i) => {
    if (d >= threshold) {
      acc.push(i);
    }
    return acc;
  }, []);
}

/**
 * Build MemoryChunks from sentence-level break-point indices.
 *
 * Groups sentences into chunks at the break-points and constructs a proper
 * MemoryChunk for each group, with correct 1-indexed startLine/endLine,
 * text, hash, and embeddingInput.
 */
function buildChunksFromBoundaries(
  sentences: SentenceWithEmbedding[],
  indicesAboveThreshold: number[],
): MemoryChunk[] {
  if (sentences.length === 0) {
    return [];
  }

  // Convert break-point indices to a Set for O(1) lookup.
  const breakSet = new Set(indicesAboveThreshold);
  const breakSetSorted = [...breakSet].toSorted((a, b) => a - b);
  const chunks: MemoryChunk[] = [];

  // Group sentences into segments; each break-point starts a new group.
  let groupStart = 0;

  for (const i of breakSetSorted) {
    // Flush the current group [groupStart .. i] as one chunk.
    const groupSentences = sentences.slice(groupStart, i + 1);
    const text = groupSentences.map((s) => s.text).join("\n");
    if (text.trim().length > 0) {
      chunks.push({
        startLine: sentences[groupStart].startLine,
        endLine: sentences[i].endLine,
        text,
        hash: hashText(text),
        embeddingInput: buildTextEmbeddingInput(text),
      });
    }
    // Start next group.
    groupStart = i + 1;
  }

  // Flush the last group.
  if (groupStart < sentences.length) {
    const groupSentences = sentences.slice(groupStart);
    const text = groupSentences.map((s) => s.text).join("\n");
    if (text.trim().length > 0) {
      chunks.push({
        startLine: sentences[groupStart].startLine,
        endLine: sentences[sentences.length - 1].endLine,
        text,
        hash: hashText(text),
        embeddingInput: buildTextEmbeddingInput(text),
      });
    }
  }

  return chunks;
}

/**
 * Semantic chunking strategy.
 *
 * Uses an external model (via callback) to identify semantic boundaries in the
 * text.  The model receives the full text and a token budget, and returns an
 * array of 0-based line indices where semantic breaks should occur.
 *
 * When the model callback is unavailable, falls back to sentence-based chunking.
 */
export class SemanticStrategy implements ChunkingStrategy {
  readonly name = "semantic" as const;
  private readonly config: ChunkingConfig;
  private readonly bufferSize: number;
  private readonly breakpointPercentileThreshold: number;
  private readonly provider: EmbeddingProvider;

  constructor(config: ChunkingConfig, provider: EmbeddingProvider) {
    this.config = config;
    this.bufferSize = config.bufferSize ?? DEFAULT_BUFFER_SIZE;
    this.breakpointPercentileThreshold = config.breakpointPercentileThreshold ?? DEFAULT_BREAKPOINT_PERCENTILE_THRESHOLD;
    this.provider = provider;
  }

  async chunk(content: string, _cfg: ChunkingConfig): Promise<MemoryChunk[]> {
    // 1. Split text into sentences (reuse the same boundary regex as SentenceStrategy).
    const rawSentences = splitIntoSentences(content);
    if (rawSentences.length === 0) {
      return [];
    }
    if (rawSentences.length === 1) {
      // Single sentence, no need for semantic chunking.
      return [{
          startLine: rawSentences[0]!.startLine,
          endLine: rawSentences[0]!.endLine,
          text: content,
          hash: hashText(content),
          embeddingInput: buildTextEmbeddingInput(content),
        }];
    }

    // 2. Combine adjacent sentences into context windows.
    let sentences = combineSentences(rawSentences, this.bufferSize);

    // 3. Compute embeddings for all combined sentences in one batch.
    const embeddingStrings = sentences.map((s) => s.combined_text ?? s.text);
    if (!this.provider) {
      throw new Error("SemanticStrategy requires an embedding provider");
    }
    const embeddings = await this.provider.embedBatch(embeddingStrings);
    for (let i = 0; i < sentences.length; i += 1) {
      sentences[i]!.embedding = embeddings[i] ?? [];
    }

    // 4. Calculate cosine distances between adjacent embeddings.
    const distances = calculateCosineDistances(sentences);
    for (let i = 0; i < distances.length; i += 1) {
      sentences[i]!.dist_to_next = distances[i];
    }

    // 5. Find sentence indices above the percentile threshold.
    const indicesAboveThreshold = getIndicesAboveThreshold(
      distances,
      this.breakpointPercentileThreshold,
    );

    // 6. Convert sentence-level break-points to line-level indices.
    return buildChunksFromBoundaries(sentences, indicesAboveThreshold);
  }
}
