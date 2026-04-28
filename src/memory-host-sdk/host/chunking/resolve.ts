import { type EmbeddingProvider } from "../embeddings.js";
import { FixedSizeStrategy } from "./fixed-size.js";
import { HiChunkStrategy } from "./hichunk.js";
import { LumberChunkerStrategy } from "./lumber.js";
import { MarkdownHeadingStrategy } from "./markdown-heading.js";
import { SemanticStrategy } from "./semantic.js";
import { SentenceStrategy } from "./sentence.js";
import type { ChunkingStrategy, LlmCompletionFn, ChunkingConfig } from "./types.js";

/**
 * Create a chunking strategy instance from a resolved configuration.
 */
export function resolveChunkingStrategy(
  config: ChunkingConfig,
  provider?: EmbeddingProvider | null,
  completionFn?: LlmCompletionFn | null,
): ChunkingStrategy {
  switch (config.strategy) {
    case "fixed-size":
      return new FixedSizeStrategy(config);
    case "markdown-heading":
      return new MarkdownHeadingStrategy(config);
    case "sentence":
      return new SentenceStrategy(config);
    case "semantic":
      if (!provider) {
        throw new Error("Semantic chunking requires an embedding provider");
      }
      return new SemanticStrategy(config, provider);
    case "lumber":
      if (!completionFn) {
        throw new Error("Lumber chunking requires an LLM completion function");
      }
      return new LumberChunkerStrategy(config, completionFn);
    case "hichunk":
      if (!completionFn) {
        throw new Error("HiChunk chunking requires an LLM completion function");
      }
      return new HiChunkStrategy(config, completionFn);
    default:
      throw new Error(`Unknown chunking strategy: ${config.strategy as string}`);
  }
}
