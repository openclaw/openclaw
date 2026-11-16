export type { AcquireConfiguredProviderLocalService } from "../agents/provider-local-service-target.js";

export {
  EMBEDDING_DEADLINE_CONTROL,
  type EmbeddingDeadlineControl,
  type EmbeddingDeadlineControlOptions,
} from "../plugins/embedding-provider-runtime-types.js";

export {
  getEmbeddingProvider,
  listEmbeddingProviders,
} from "../plugins/embedding-provider-runtime.js";

export type {
  EmbeddingInput,
  EmbeddingProvider,
  EmbeddingProviderCallOptions,
  EmbeddingProviderIndexIdentity,
  EmbeddingProviderRuntime,
  EmbeddingUsage,
} from "../plugins/embedding-provider-runtime-types.js";
export type {
  EmbeddingProviderAdapter,
  EmbeddingProviderCreateOptions,
  EmbeddingProviderCreateResult,
} from "../plugins/embedding-provider-types.js";
