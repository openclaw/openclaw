import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../../config/types.js";
import { canonicalizeRealtimeTranscriptionProviderId } from "../../../realtime-transcription/provider-registry.js";
import { getVoiceProviderConfig } from "../../../tts/voice-models.js";
import {
  buildTalkTranscriptionConfig,
  configuredOrFalseAsync,
  listTalkTranscriptionProviders,
  resolveConfiguredRealtimeTranscriptionProvider,
} from "../session-config.js";

export async function resolveCatalogProviderSelection<T extends { provider: { id: string } }>(
  configuredProvider: string | undefined,
  resolveAutomaticProvider: () => Promise<T>,
) {
  // Provider priority belongs to the runtime resolver; catalog consumers must not infer it from row order.
  try {
    const resolvedProvider = await resolveAutomaticProvider();
    return {
      activeProvider: resolvedProvider.provider.id,
      ready: true,
      resolved: resolvedProvider,
    };
  } catch {
    return {
      ...(configuredProvider ? { activeProvider: configuredProvider } : {}),
      ready: false,
      resolved: undefined,
    };
  }
}

export async function buildTalkTranscriptionCatalog(config: OpenClawConfig, agentId: string) {
  const transcriptionConfig = await buildTalkTranscriptionConfig(
    config,
    undefined,
    undefined,
    agentId,
  );
  const transcriptionSelection = transcriptionConfig.file
    ? { ready: transcriptionConfig.file.ready, activeProvider: transcriptionConfig.file.provider }
    : await resolveCatalogProviderSelection(
        canonicalizeRealtimeTranscriptionProviderId(transcriptionConfig.provider, config),
        () =>
          resolveConfiguredRealtimeTranscriptionProvider({
            config,
            configuredProviderId: transcriptionConfig.provider,
            providerConfigs: transcriptionConfig.providers,
            defaultModel: transcriptionConfig.model,
          }),
      );
  const activeTranscriptionProvider = transcriptionSelection.activeProvider;
  return {
    ready: transcriptionSelection.ready,
    ...(activeTranscriptionProvider ? { activeProvider: activeTranscriptionProvider } : {}),
    providers: transcriptionConfig.file
      ? transcriptionConfig.file.providers.map((provider) => ({
          ...provider,
          label: provider.id,
          modes: ["transcription"],
          transports: ["gateway-relay"],
          brains: ["none"],
        }))
      : await Promise.all(
          listTalkTranscriptionProviders(config, [
            transcriptionConfig.provider,
            ...Object.keys(transcriptionConfig.providers),
          ]).map(async (provider) => {
            const rawConfig = getVoiceProviderConfig({
              providerConfigs: transcriptionConfig.providers,
              provider,
              configuredProviderId:
                activeTranscriptionProvider &&
                normalizeOptionalLowercaseString(provider.id) ===
                  normalizeOptionalLowercaseString(activeTranscriptionProvider)
                  ? transcriptionConfig.provider
                  : undefined,
            });
            const rawConfigWithModel =
              transcriptionConfig.model && rawConfig.model === undefined
                ? { ...rawConfig, model: transcriptionConfig.model }
                : rawConfig;
            const providerConfig =
              provider.resolveConfig?.({ cfg: config, rawConfig: rawConfigWithModel }) ??
              rawConfigWithModel;
            const entry: Record<string, unknown> = {
              id: provider.id,
              label: provider.label,
              configured: await configuredOrFalseAsync(
                () =>
                  provider.isConfiguredAsync?.({ cfg: config, providerConfig }) ??
                  provider.isConfigured?.({ cfg: config, providerConfig }) ??
                  false,
              ),
              modes: ["transcription"],
              transports: ["gateway-relay"],
              brains: ["none"],
            };
            if (provider.models?.length) {
              entry.models = [...provider.models];
            }
            if (provider.defaultModel) {
              entry.defaultModel = provider.defaultModel;
            }
            if (provider.aliases?.length) {
              entry.aliases = [...provider.aliases];
            }
            return entry;
          }),
        ),
  };
}
