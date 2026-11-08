import type { EmbeddingInput } from "../../packages/memory-host-sdk/src/host/embedding-inputs.js";
import type {
  EmbeddingBatchChunk,
  EmbeddingBatchOptions,
  EmbeddingProvider,
  EmbeddingProviderCallOptions,
  EmbeddingProviderIndexIdentity,
  EmbeddingProviderRuntime,
} from "./embedding-provider-runtime-types.js";

export type MemoryEmbeddingBatchChunk = EmbeddingBatchChunk & {
  embeddingInput?: EmbeddingInput;
};

export type MemoryEmbeddingBatchOptions = Omit<EmbeddingBatchOptions, "chunks"> & {
  chunks: MemoryEmbeddingBatchChunk[];
};

export type MemoryEmbeddingProviderCallOptions = Pick<EmbeddingProviderCallOptions, "signal">;

export type MemoryEmbeddingProviderRuntime = Omit<EmbeddingProviderRuntime, "batchEmbed"> & {
  batchEmbed?: (options: MemoryEmbeddingBatchOptions) => Promise<number[][] | null>;
};

export type MemoryEmbeddingProviderIndexIdentity = EmbeddingProviderIndexIdentity;

export type MemoryEmbeddingProvider = EmbeddingProvider;
