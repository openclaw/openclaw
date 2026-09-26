// Defines model selection and provider configuration types.

import type { z } from "zod";
import type {
  ModelDataImageInputConfig,
  ModelDataMediaInputConfig,
} from "../../packages/llm-core/src/model-data.js";
import type { OpenAICompletionsCompat, RawModelCostConfig } from "../llm/types.js";
import type { AgentRuntimePolicyConfig } from "./types.agents-shared.js";
import type { ConfiguredModelProviderRequest } from "./types.provider-request.js";
import type { SecretInput } from "./types.secrets.js";
import type { ModelsConfigSchema } from "./zod-schema.core.js";

export {
  MODEL_APIS,
  MODEL_THINKING_FORMATS,
  isModelThinkingFormat,
  type ModelApi,
  type SupportedThinkingFormat,
} from "./model-config-vocabulary.js";

type ModelsSchemaInput = NonNullable<z.input<typeof ModelsConfigSchema>>;

type ModelProviderSchemaInput = NonNullable<ModelsSchemaInput["providers"]>[string];

type ModelDefinitionSchemaInput = NonNullable<ModelProviderSchemaInput["models"]>[number];

/** Provider/model compatibility switches consumed by request builders and tool schema adapters. */
export type ModelCompatConfig = Omit<
  NonNullable<ModelDefinitionSchemaInput["compat"]>,
  "openRouterRouting" | "vercelGatewayRouting"
> &
  Pick<OpenAICompletionsCompat, "openRouterRouting" | "vercelGatewayRouting">;

export type ModelImageInputConfig = ModelDataImageInputConfig;

export type ModelMediaInputConfig = ModelDataMediaInputConfig;

/** Authentication mode expected by a configured model provider. */
export type ModelProviderAuthMode = NonNullable<ModelProviderSchemaInput["auth"]>;

export type ModelProviderLocalServiceConfig = NonNullable<ModelProviderSchemaInput["localService"]>;

export type ModelDefinitionConfig = Omit<
  ModelDefinitionSchemaInput,
  "reasoning" | "input" | "cost" | "maxTokens" | "agentRuntime" | "mediaInput" | "compat"
> & {
  /** Whether the model supports reasoning/thinking controls. */
  reasoning: boolean;
  /** Supported input modalities for routing and media-tool selection. */
  input: NonNullable<ModelDefinitionSchemaInput["input"]>;
  /** Token pricing in USD per million tokens. */
  cost: RawModelCostConfig;
  /** Maximum completion/output token budget. */
  maxTokens: number;
  /** Optional agent execution runtime override for this provider/model pair. */
  agentRuntime?: AgentRuntimePolicyConfig;
  /** Provider compatibility flags for payload shaping and feature gating. */
  compat?: ModelCompatConfig;
  /** Media input limits used by routing and preflight compression. */
  mediaInput?: ModelMediaInputConfig;
};

export type ModelProviderConfig = Omit<
  ModelProviderSchemaInput,
  "baseUrl" | "models" | "apiKey" | "headers" | "request" | "agentRuntime"
> & {
  /** Provider API base URL. */
  baseUrl: string;
  /** API key or secret reference for this provider. */
  apiKey?: SecretInput;
  /** Secret-bearing headers merged into provider requests. */
  headers?: Record<string, SecretInput>;
  /** Provider request transport/retry overrides. */
  request?: ConfiguredModelProviderRequest;
  /** Optional default agent execution runtime for models under this provider. */
  agentRuntime?: AgentRuntimePolicyConfig;
  /** Model catalog entries exposed by this provider. */
  models: ModelDefinitionConfig[];
};

/** Fully materialized provider declaration emitted by provider catalog plugins. */
export type ModelProviderDeclarationConfig = ModelProviderConfig;

/** User config input shape before provider defaults/models are materialized. */
export type ModelProviderConfigInput = Omit<Partial<ModelProviderConfig>, "models"> & {
  models?: ModelDefinitionConfig[];
};

export type BedrockDiscoveryConfig = {
  /** Enable AWS Bedrock model discovery. */
  enabled?: boolean;
  /** AWS region to query for models. */
  region?: string;
  /** Optional provider id filters for discovery. */
  providerFilter?: string[];
  /** Discovery cache refresh interval in seconds. */
  refreshInterval?: number;
  /** Context window applied when discovery cannot infer one. */
  defaultContextWindow?: number;
  /** Max output tokens applied when discovery cannot infer one. */
  defaultMaxTokens?: number;
};

export type DiscoveryToggleConfig = {
  /** Enables the named discovery source. */
  enabled?: boolean;
};

export type ModelCatalogRefreshConfig = NonNullable<ModelsSchemaInput["catalogRefresh"]>;

export type ModelsConfig = Omit<ModelsSchemaInput, "providers"> & {
  /** Configured provider catalog keyed by provider id. */
  providers?: Record<string, ModelProviderConfig>;
};

/** Top-level models config input before provider entries are normalized. */
export type ModelsConfigInput = Omit<ModelsConfig, "providers"> & {
  providers?: Record<string, ModelProviderConfigInput>;
};
