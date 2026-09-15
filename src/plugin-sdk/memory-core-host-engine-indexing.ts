// Immutable preparation workers use pure helpers without loading providers or store writers.
export {
  chunkMarkdown,
  remapChunkLines,
  type MemoryChunk,
} from "../../packages/memory-host-sdk/src/host/markdown-chunks.js";
export { hashText } from "../../packages/memory-host-sdk/src/host/hash.js";
export { enforceEmbeddingMaxInputTokens } from "../../packages/memory-host-sdk/src/host/embedding-chunk-limits.js";
// memory-core reaches shared host primitives through the plugin SDK boundary.
// Re-export Markdown Core's owner instead of maintaining a second frontmatter grammar.
export {
  extractFrontmatterBlock,
  type ExtractedFrontmatterBlock,
  type FrontmatterLineRange,
} from "../../packages/markdown-core/src/frontmatter-extract.js";
export {
  extractCuratedEntryRecallMetadata,
  stripMemoryAnnotationCarriers,
} from "../../packages/memory-host-sdk/src/host/curated-annotations.js";
export type {
  MemoryEntryProvenance,
  MemorySource,
} from "../../packages/memory-host-sdk/src/host/types.js";
