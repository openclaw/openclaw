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
// Keep shared setup barrels off the generated plugin facades. Source-first
// facade loading can otherwise recurse back into the same plugin while its
// public surface is still evaluating.
export { OLLAMA_DEFAULT_BASE_URL, OLLAMA_DEFAULT_MODEL } from "../../extensions/ollama/api.js";
export {
  buildOllamaProvider,
  configureOllamaNonInteractive,
  ensureOllamaModelPulled,
  promptAndConfigureOllama,
} from "../../extensions/ollama/api.js";
export {
  VLLM_DEFAULT_BASE_URL,
  VLLM_DEFAULT_CONTEXT_WINDOW,
  VLLM_DEFAULT_COST,
  VLLM_DEFAULT_MAX_TOKENS,
  promptAndConfigureVllm,
} from "../plugins/provider-vllm-setup.js";

const VLLM_FACADE_IMPORT = "./vllm.js";
const SGLANG_FACADE_IMPORT = "./sglang.js";

export async function buildVllmProvider(params?: { baseUrl?: string; apiKey?: string }) {
  return await (await import(VLLM_FACADE_IMPORT)).buildVllmProvider(params);
}

export async function buildSglangProvider(params?: { baseUrl?: string; apiKey?: string }) {
  return await (await import(SGLANG_FACADE_IMPORT)).buildSglangProvider(params);
}
