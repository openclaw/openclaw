// Chunking strategy types and interfaces
export type {
  ChunkingConfig,
  ChunkingStrategy,
  ChunkingStrategyName,
  LlmCompletionFn,
  MemoryChunk,
} from "./types.js";

// Strategy implementations
export {
  FixedSizeStrategy,
  chunkFixedSize,
  DEFAULT_CHUNK_TOKENS,
  DEFAULT_CHUNK_OVERLAP,
} from "./fixed-size.js";
export {
  HiChunkStrategy,
  DEFAULT_WINDOW_SIZE,
  DEFAULT_LINE_MAX_LEN,
  DEFAULT_MAX_LEVEL,
  DEFAULT_RECURRENT_TYPE,
} from "./hichunk.js";
export { LumberChunkerStrategy, DEFAULT_LUMBER_THETA } from "./lumber.js";
export {
  MarkdownHeadingStrategy,
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_TOKENS,
} from "./markdown-heading.js";
export { SentenceStrategy, DEFAULT_TARGET_TOKENS, DEFAULT_OVERLAP_SENTENCES } from "./sentence.js";
export {
  SemanticStrategy,
  DEFAULT_BUFFER_SIZE,
  DEFAULT_BREAKPOINT_PERCENTILE_THRESHOLD,
} from "./semantic.js";

// Factory
export { resolveChunkingStrategy } from "./resolve.js";
