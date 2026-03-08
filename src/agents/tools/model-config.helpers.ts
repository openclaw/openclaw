import type { OpenClawConfig } from "../../config/config.js";
import { ensureAuthProfileStore, listProfilesForProvider } from "../auth-profiles.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../defaults.js";
import { resolveEnvApiKey } from "../model-auth.js";
import { resolveConfiguredModelRef } from "../model-selection.js";

/**
 * Resolve the default model reference, checking for available credentials first.
 * If no credentials are available for the default provider (Anthropic), returns
 * a fallback that doesn't require specific credentials.
 */
export function resolveDefaultModelRef(cfg?: OpenClawConfig): { provider: string; model: string } {
  if (cfg) {
    const resolved = resolveConfiguredModelRef({
      cfg,
      defaultProvider: DEFAULT_PROVIDER,
      defaultModel: DEFAULT_MODEL,
    });
    // Check if we have credentials for the resolved provider
    if (hasAuthForProvider({ provider: resolved.provider, agentDir: "" })) {
      return { provider: resolved.provider, model: resolved.model };
    }
  } else {
    // Check if we have credentials for the default provider
    if (hasAuthForProvider({ provider: DEFAULT_PROVIDER, agentDir: "" })) {
      return { provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL };
    }
  }
  
  // No Anthropic credentials available - return a provider-agnostic default
  // that will work with local models like Ollama
  return { provider: "", model: "" };
}

export function hasAuthForProvider(params: { provider: string; agentDir: string }): boolean {
  if (resolveEnvApiKey(params.provider)?.apiKey) {
    return true;
  }
  const store = ensureAuthProfileStore(params.agentDir, {
    allowKeychainPrompt: false,
  });
  return listProfilesForProvider(store, params.provider).length > 0;
}
