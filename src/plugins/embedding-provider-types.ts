/** Contracts for plugin-contributed embedding provider creation and registration. */
import type { AcquireConfiguredProviderLocalService } from "../agents/provider-local-service-target.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SecretInput } from "../config/types.secrets.js";
import type {
  EmbeddingProvider,
  EmbeddingProviderIndexIdentity,
  EmbeddingProviderRuntime,
} from "./embedding-provider-runtime-types.js";

/** Options passed to embedding provider adapters when creating providers. */
export type EmbeddingProviderCreateOptions = {
  config: OpenClawConfig;
  agentDir?: string;
  /** Host-injected acquisition of the configured provider's local service. */
  acquireLocalService?: AcquireConfiguredProviderLocalService;
  provider?: string;
  remote?: {
    baseUrl?: string;
    apiKey?: SecretInput;
    headers?: Record<string, string>;
  };
  model: string;
  inputType?: string;
  queryInputType?: string;
  documentInputType?: string;
  local?: {
    modelPath?: string;
    modelCacheDir?: string;
  };
  dimensions?: number;
  taskType?: string;
};

/** Result returned by an embedding provider adapter create call. */
export type EmbeddingProviderCreateResult = {
  provider: EmbeddingProvider | null;
  runtime?: EmbeddingProviderRuntime;
};

/** Non-text input a model embeds into the same vector space as its text. */
export type EmbeddingMediaModality = "image" | "audio";

/** Adapter contract registered by core or plugin embedding providers. */
export type EmbeddingProviderAdapter = {
  id: string;
  /** Alternate lookup ids; creation and index identity retain the canonical id. */
  aliases?: readonly string[];
  defaultModel?: string;
  transport?: "local" | "remote";
  authProviderId?: string;
  /** Canonical model from config only: synchronous, without auth or network access. */
  normalizeModel?: (options: EmbeddingProviderCreateOptions) => string;
  resolveIndexIdentity?: (
    options: EmbeddingProviderCreateOptions,
  ) => EmbeddingProviderIndexIdentity;
  /**
   * Media this model embeds alongside text, which the adapter's requests must carry as
   * inline-data parts. Absent or empty means text only.
   */
  mediaModalities?: (params: { model: string }) => readonly EmbeddingMediaModality[];
  create: (options: EmbeddingProviderCreateOptions) => Promise<EmbeddingProviderCreateResult>;
  formatSetupError?: (err: unknown) => string;
};

/** Registered embedding provider with optional owning plugin metadata. */
export type RegisteredEmbeddingProvider = {
  adapter: EmbeddingProviderAdapter;
  ownerPluginId?: string;
};
