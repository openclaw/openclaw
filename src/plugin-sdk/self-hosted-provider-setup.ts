// Focused self-hosted provider setup helpers for OpenAI-compatible backends.
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

const VLLM_FACADE_IMPORT = "./vllm.js";
const SGLANG_FACADE_IMPORT = "./sglang.js";

export async function buildVllmProvider(params?: { baseUrl?: string; apiKey?: string }) {
  return await (await import(VLLM_FACADE_IMPORT)).buildVllmProvider(params);
}

export async function buildSglangProvider(params?: { baseUrl?: string; apiKey?: string }) {
  return await (await import(SGLANG_FACADE_IMPORT)).buildSglangProvider(params);
}
