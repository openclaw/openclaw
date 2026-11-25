import { listProfilesForProvider } from "./auth-profiles/profile-list.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import { resolveProviderModelAuthPolicy } from "./model-auth-policy.js";
import { profileTypeToAuthMode } from "./model-auth-provider-config.js";

/**
 * True when the provider's own auth policy refuses a saved sign-in for voice and asks for an
 * API key instead, as OpenAI does for Sign in with ChatGPT. Callers own whether a usable key
 * already exists; a provider that is ready for voice never needs this.
 */
export function signInNeedsApiKeyForVoice(store: AuthProfileStore, provider: string): boolean {
  return listProfilesForProvider(store, provider).some((profileId) => {
    const credential = store.profiles[profileId];
    if (!credential || credential.type === "api_key") {
      return false;
    }
    const policy = resolveProviderModelAuthPolicy({
      provider,
      mode: profileTypeToAuthMode(credential.type),
      authFlow: credential.type === "oauth" ? credential.authFlow : undefined,
      capability: "audio-transcription",
    });
    return !policy.compatible && policy.authRequirement === "api-key";
  });
}
