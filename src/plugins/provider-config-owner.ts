import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { OpenClawConfig } from "../config/types.openclaw.js";

/** Core model APIs that do not imply a separate plugin owner for provider config. */
const CORE_BUILT_IN_MODEL_APIS = new Set([
  "anthropic-messages",
  "azure-openai-responses",
  "google-generative-ai",
  "google-vertex",
  "mistral-conversations",
  "openai-chatgpt-responses",
  "openai-completions",
  "openai-responses",
]);

/** Resolves the plugin-owned API id behind a configured provider, when it differs from core. */
export function resolveProviderConfigApiOwnerHint(params: {
  provider: string;
  config?: OpenClawConfig;
}): string | undefined {
  const providers = params.config?.models?.providers;
  if (!providers) {
    return undefined;
  }
  const normalizedProvider = normalizeProviderId(params.provider);
  if (!normalizedProvider) {
    return undefined;
  }
  const providerConfig =
    providers[params.provider] ??
    Object.entries(providers).find(
      ([candidateId]) => normalizeProviderId(candidateId) === normalizedProvider,
    )?.[1];
  const api =
    typeof providerConfig?.api === "string" ? normalizeProviderId(providerConfig.api) : "";
  // Built-in API ids are implemented by core provider adapters. Only non-built-in API ids
  // need to activate or search plugin owners on behalf of the configured provider alias.
  if (!api || api === normalizedProvider || CORE_BUILT_IN_MODEL_APIS.has(api)) {
    return undefined;
  }
  return api;
}
