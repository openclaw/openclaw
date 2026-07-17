// Defines runtime model metadata supplied by provider plugins.
import type { Model } from "openclaw/plugin-sdk/llm";
import type { ModelCompatConfig, ModelMediaInputConfig } from "../config/types.models.js";
import type { OpenAIResponsesCompat } from "../llm/types.js";

type ProviderRuntimeModelCompat = ModelCompatConfig &
  Pick<OpenAIResponsesCompat, "collapseRotatingMessageSnapshots">;

/**
 * Fully-resolved runtime model shape used after provider/plugin-owned
 * discovery, overrides, and compat normalization.
 */
export type ProviderRuntimeModel = Omit<Model, "compat"> & {
  compat?: ProviderRuntimeModelCompat;
  contextTokens?: number;
  params?: Record<string, unknown>;
  requestTimeoutMs?: number;
  mediaInput?: ModelMediaInputConfig;
};
