// Defines runtime model metadata supplied by provider plugins.
import type { Model } from "openclaw/plugin-sdk/llm";
import type { ModelCompatConfig, ModelMediaInputConfig } from "../config/types.models.js";

/**
 * Fully-resolved runtime model shape used after provider/plugin-owned
 * discovery, overrides, and compat normalization.
 */
export type ProviderRuntimeModel = Omit<Model, "compat"> & {
  compat?: ModelCompatConfig & {
    /** Provider-owned capability for forwarding explicit cache-retention settings. */
    supportsCacheRetention?: boolean;
  };
  contextTokens?: number;
  params?: Record<string, unknown>;
  requestTimeoutMs?: number;
  mediaInput?: ModelMediaInputConfig;
};
