// Curated setup helpers for provider plugins that integrate local/self-hosted models.
export type {
  OpenClawPluginApi,
  ProviderAuthContext,
  ProviderAuthMethodNonInteractiveContext,
  ProviderAuthResult,
  ProviderDiscoveryContext,
} from "../plugins/types.js";

export {
  applyProviderDefaultModel,
  configureOpenAICompatibleSelfHostedProviderNonInteractive,
  discoverOpenAICompatibleLocalModels,
  discoverOpenAICompatibleSelfHostedProvider,
  promptAndConfigureOpenAICompatibleSelfHostedProvider,
  promptAndConfigureOpenAICompatibleSelfHostedProviderAuth,
  SELF_HOSTED_DEFAULT_CONTEXT_WINDOW,
  SELF_HOSTED_DEFAULT_COST,
  SELF_HOSTED_DEFAULT_MAX_TOKENS,
} from "../plugins/provider-self-hosted-setup.js";
export { OLLAMA_DEFAULT_BASE_URL, OLLAMA_DEFAULT_MODEL } from "./ollama-surface.js";
export {
  buildOllamaProvider,
  configureOllamaNonInteractive,
  ensureOllamaModelPulled,
  promptAndConfigureOllama,
} from "./ollama-surface.js";
export {
  VLLM_DEFAULT_BASE_URL,
  VLLM_DEFAULT_CONTEXT_WINDOW,
  VLLM_DEFAULT_COST,
  VLLM_DEFAULT_MAX_TOKENS,
  promptAndConfigureVllm,
} from "../plugins/provider-vllm-setup.js";
// Lazy re-exports to break circular facade cycle:
// provider-setup → vllm.ts (facade) → extensions/vllm/api.ts → provider-setup
export const buildVllmProvider: typeof import("./vllm.js").buildVllmProvider = ((...args: Parameters<typeof import("./vllm.js").buildVllmProvider>) => {
  const { buildVllmProvider: fn } = require("./vllm.js") as typeof import("./vllm.js");
  return fn(...args);
}) as typeof import("./vllm.js").buildVllmProvider;
export const buildSglangProvider: typeof import("./sglang.js").buildSglangProvider = ((...args: Parameters<typeof import("./sglang.js").buildSglangProvider>) => {
  const { buildSglangProvider: fn } = require("./sglang.js") as typeof import("./sglang.js");
  return fn(...args);
}) as typeof import("./sglang.js").buildSglangProvider;
