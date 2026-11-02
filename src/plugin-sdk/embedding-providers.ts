export type { AcquireConfiguredProviderLocalService } from "../agents/provider-local-service-target.js";

export {
  EMBEDDING_DEADLINE_CONTROL,
  type EmbeddingDeadlineControl,
  type EmbeddingDeadlineControlOptions,
} from "../plugins/embedding-provider-types.js";

export {
  getEmbeddingProvider,
  listEmbeddingProviders,
} from "../plugins/embedding-provider-runtime.js";

export type {
  EmbeddingInput,
  EmbeddingProvider,
  EmbeddingProviderAdapter,
  EmbeddingProviderCallOptions,
  EmbeddingProviderCreateOptions,
  EmbeddingProviderCreateResult,
  EmbeddingProviderIndexIdentity,
  EmbeddingProviderRuntime,
  EmbeddingUsage,
} from "../plugins/embedding-providers.js";
