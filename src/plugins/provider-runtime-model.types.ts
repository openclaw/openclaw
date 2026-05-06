import type { Api, Model } from "../agents/pi-ai-contract.js";

/**
 * Fully-resolved runtime model shape used after provider/plugin-owned
 * discovery, overrides, and compat normalization.
 */
export type ProviderRuntimeModel = Model<Api> & {
  contextTokens?: number;
  params?: Record<string, unknown>;
  requestTimeoutMs?: number;
};
