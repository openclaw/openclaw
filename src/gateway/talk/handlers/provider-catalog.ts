import type { OpenClawConfig } from "../../../config/types.js";
import { canonicalizeRealtimeTranscriptionProviderId } from "../../../realtime-transcription/provider-registry.js";
import { getVoiceProviderConfig } from "../../../tts/voice-models.js";
import {
  buildTalkTranscriptionConfig,
  listTalkTranscriptionProviders,
  resolveConfiguredRealtimeTranscriptionProvider,
} from "../session-config.js";

/** A failed row must not release single-flight custody of its still-running siblings. */
export async function settleTalkCatalogTasks<const T extends readonly Promise<unknown>[]>(
  tasks: T,
): Promise<{ -readonly [P in keyof T]: Awaited<T[P]> }> {
  try {
    return await Promise.all(tasks);
  } finally {
    await Promise.allSettled(tasks);
  }
}

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

export async function buildTalkTranscriptionCatalog(
  config: OpenClawConfig,
  agentId: string,
  onReadinessError: (error: unknown) => false,
) {
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
      : await settleTalkCatalogTasks(
          listTalkTranscriptionProviders(config, [
            transcriptionConfig.provider,
            ...Object.keys(transcriptionConfig.providers),
          ]).map(async (provider) => {
            let configured =
              transcriptionSelection.ready && provider.id === activeTranscriptionProvider;
            if (!configured) {
              const rawConfig = getVoiceProviderConfig({
                providerConfigs: transcriptionConfig.providers,
                provider,
                configuredProviderId:
                  provider.id === activeTranscriptionProvider
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
              try {
                configured = await (provider.isConfiguredAsync?.({ cfg: config, providerConfig }) ??
                  provider.isConfigured?.({ cfg: config, providerConfig }) ??
                  false);
              } catch (error) {
                configured = onReadinessError(error);
              }
            }
            const entry: Record<string, unknown> = {
              id: provider.id,
              label: provider.label,
              configured,
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
