import type { OpenClawConfig } from "../config/types.js";
import { getActiveRuntimePluginRegistry } from "../plugins/active-runtime-registry.js";
import { withAcquiredPluginCapabilityProviders } from "../plugins/capability-provider-acquisition.js";
import {
  resolvePluginCapabilityProvider,
  resolvePluginCapabilityProviderAsync,
  resolvePluginCapabilityProviders,
  resolvePluginCapabilityProvidersAsync,
} from "../plugins/capability-provider-runtime.js";
import { createLegacyPluginSdkProviderProjection } from "../plugins/legacy-sdk-provider-projection.js";
import { buildCapabilityProviderIndex } from "../plugins/provider-registry-shared.js";
import { warnPluginSdkDeprecation } from "../plugins/sdk-deprecation.js";
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

export type SpeechProviderRegistry = ReturnType<typeof createSpeechProviderRegistry>;

/** Keep provider callbacks inside one acquisition while callers derive their local view. */
export async function withSpeechProviderRegistry<T>(
  cfg: OpenClawConfig | undefined,
  run: (registry: SpeechProviderRegistry) => T | Promise<T>,
): Promise<T> {
  return await withAcquiredPluginCapabilityProviders(
    { key: "speechProviders", cfg },
    (providers) => {
      const byId = buildCapabilityProviderIndex(providers, "aliases");
      return run(
        createSpeechProviderRegistry({
          getProvider: (providerId) => byId.get(providerId),
          listProviders: () => providers,
        }),
      );
    },
  );
}

function warnSyncSpeechRegistry(method: string, replacement: string): void {
  warnPluginSdkDeprecation({
    family: "speech-registry-sync",
    method,
    replacement,
    compatibility: "The synchronous API requires an already prepared and loaded speech registry.",
  });
}

/** @deprecated Await listSpeechProvidersAsync; synchronous reads require a loaded registry. */
export function listSpeechProviders(cfg?: OpenClawConfig): SpeechProviderPlugin[] {
  warnSyncSpeechRegistry("listSpeechProviders", "listSpeechProvidersAsync");
  return defaultSpeechProviderRegistry.listSpeechProviders(cfg);
}

export async function listSpeechProvidersAsync(
  cfg?: OpenClawConfig,
): Promise<SpeechProviderPlugin[]> {
  using projection = createLegacyPluginSdkProviderProjection();
  const providers = await resolvePluginCapabilityProvidersAsync(
    { key: "speechProviders", cfg },
    (registry) => projection.select(registry),
  );
  projection.adopt();
  return [...buildCapabilityProviderIndex(providers, "canonical").values()];
}
/** List currently loaded speech providers from the active runtime registry. */
export function listLoadedSpeechProviders(_cfg?: OpenClawConfig): SpeechProviderPlugin[] {
  const providers = (getActiveRuntimePluginRegistry()?.speechProviders ?? []).map(
    (entry) => entry.provider,
  );
  return [...buildCapabilityProviderIndex(providers, "canonical").values()];
}
/** @deprecated Await getSpeechProviderAsync; synchronous reads require a loaded registry. */
export function getSpeechProvider(providerId: string | undefined, cfg?: OpenClawConfig) {
  warnSyncSpeechRegistry("getSpeechProvider", "getSpeechProviderAsync");
  return defaultSpeechProviderRegistry.getSpeechProvider(providerId, cfg);
}

export async function getSpeechProviderAsync(providerId: string | undefined, cfg?: OpenClawConfig) {
  if (!providerId?.trim()) {
    return undefined;
  }
  using projection = createLegacyPluginSdkProviderProjection();
  const provider = await resolvePluginCapabilityProviderAsync(
    { key: "speechProviders", providerId, cfg },
    (registry) => projection.select(registry),
  );
  projection.adopt();
  return provider;
}

/** @deprecated Await canonicalizeSpeechProviderIdAsync; synchronous reads require a loaded registry. */
export function canonicalizeSpeechProviderId(providerId: string | undefined, cfg?: OpenClawConfig) {
  warnSyncSpeechRegistry("canonicalizeSpeechProviderId", "canonicalizeSpeechProviderIdAsync");
  return defaultSpeechProviderRegistry.canonicalizeSpeechProviderId(providerId, cfg);
}

export async function canonicalizeSpeechProviderIdAsync(
  providerId: string | undefined,
  cfg?: OpenClawConfig,
) {
  return await withSpeechProviderRegistry(cfg, (registry) =>
    registry.canonicalizeSpeechProviderId(providerId),
  );
}
