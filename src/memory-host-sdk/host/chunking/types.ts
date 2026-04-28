import { type EmbeddingInput } from "../embedding-inputs.js";

export type MemoryChunk = {
  startLine: number;
  endLine: number;
  text: string;
  hash: string;
  embeddingInput?: EmbeddingInput;
};

/** Supported chunking strategy names. */
export type ChunkingStrategyName =
  | "fixed-size"
  | "markdown-heading"
  | "sentence"
  | "semantic"
  | "lumber"
  | "hichunk";

/** Lightweight LLM completion callback for strategies that need text generation. */
export type LlmCompletionFn = (prompt: string) => Promise<string>;

// /** User-facing chunking configuration (optional fields, before defaults). */
export type ChunkingConfig = {
  strategy: ChunkingStrategyName;
  completionModel?: string | undefined;
  tokens?: number | undefined;
  overlap?: number | undefined;
  maxDepth?: number | undefined;
  maxTokens?: number | undefined;
  targetTokens?: number | undefined;
  overlapSentences?: number | undefined;
  bufferSize?: number | undefined;
  breakpointPercentileThreshold?: number | undefined;
  theta?: number | undefined;
  windowSize?: number | undefined;
  lineMaxLen?: number | undefined;
  maxLevel?: number | undefined;
  recurrentType?: number | undefined;
};

/** Unified chunking strategy interface. All strategies implement this. */
export interface ChunkingStrategy {
  readonly name: ChunkingStrategyName;

  /**
   * Split content into chunks.
   * @param content  The full text content to chunk.
   * @param cfg  Chunking configuration.
   * @returns Array of memory chunks.
   */
  chunk(content: string, cfg: ChunkingConfig): Promise<MemoryChunk[]> | MemoryChunk[];
}
