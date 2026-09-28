// TTS provider registry resolves configured speech providers at runtime.
import type { OpenClawConfig } from "../config/types.js";
import { getActiveRuntimePluginRegistry } from "../plugins/active-runtime-registry.js";
import {
  resolvePluginCapabilityProvider,
  resolvePluginCapabilityProviders,
} from "../plugins/capability-provider-runtime.js";
import { buildCapabilityProviderIndex } from "../plugins/provider-registry-shared.js";
import type { SpeechProviderPlugin } from "../plugins/types.js";
import { createSpeechProviderRegistry } from "./provider-registry-core.js";
export { normalizeSpeechProviderId } from "./provider-registry-core.js";

/** Config-aware registry used by setup/status/runtime paths before plugins are loaded. */
const defaultSpeechProviderRegistry = createSpeechProviderRegistry({
  getProvider: (providerId, cfg) =>
    resolvePluginCapabilityProvider({
      key: "speechProviders",
      providerId,
      cfg,
    }),
  listProviders: (cfg) => resolvePluginCapabilityProviders({ key: "speechProviders", cfg }),
});

/** List configured speech providers using manifest/capability discovery. */
export const listSpeechProviders = defaultSpeechProviderRegistry.listSpeechProviders;
/** List currently loaded speech providers from the active runtime registry. */
export function listLoadedSpeechProviders(_cfg?: OpenClawConfig): SpeechProviderPlugin[] {
  const providers = (getActiveRuntimePluginRegistry()?.speechProviders ?? []).map(
    (entry) => entry.provider,
  );
  return [...buildCapabilityProviderIndex(providers, "canonical").values()];
}
/** Resolve a configured speech provider by canonical ID or alias. */
export const getSpeechProvider = defaultSpeechProviderRegistry.getSpeechProvider;
/** Resolve an input provider ID or alias to the provider's canonical ID. */
export const canonicalizeSpeechProviderId =
  defaultSpeechProviderRegistry.canonicalizeSpeechProviderId;
