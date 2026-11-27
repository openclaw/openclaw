// Immutable preparation workers use pure helpers without loading providers or store writers.
import { sha256Hex } from "@openclaw/normalization-core/node-crypto";

export {
  chunkMarkdown,
  createMarkdownChunker,
  remapChunkLines,
  type MemoryChunk,
} from "../../packages/memory-host-sdk/src/host/markdown-chunks.js";
export const hashText: (value: string) => string = sha256Hex;
export { encodeMemoryEmbedding } from "../../packages/memory-host-sdk/src/host/embedding-vector.js";
export { enforceEmbeddingMaxInputTokens } from "../../packages/memory-host-sdk/src/host/embedding-chunk-limits.js";
export { resolveEmbeddingInputFormatVersion } from "../../packages/memory-host-sdk/src/host/embedding-inputs.js";
export {
  extractCuratedEntryRecallMetadata,
  stripMemoryAnnotationCarriers,
} from "../../packages/memory-host-sdk/src/host/curated-annotations.js";
export type {
  MemoryEntryProvenance,
  MemorySource,
} from "../../packages/memory-host-sdk/src/host/types.js";
