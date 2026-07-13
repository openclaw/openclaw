// Builds the talk.catalog projection of speech, transcription, and realtime providers.
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { getVoiceProviderConfig } from "../../../packages/speech-core/voice-models.js";
import { resolveActiveTalkProviderConfig } from "../../config/talk.js";
import type { OpenClawConfig } from "../../config/types.js";
import { resolveProviderRawConfig } from "../../plugin-sdk/provider-selection-runtime.js";
import { canonicalizeRealtimeTranscriptionProviderId } from "../../realtime-transcription/provider-registry.js";
import {
  canonicalizeRealtimeVoiceProviderId,
  listRealtimeVoiceProviders,
} from "../../talk/provider-registry.js";
import { resolveConfiguredRealtimeVoiceProvider } from "../../talk/provider-resolver.js";
import { canonicalizeSpeechProviderId, listSpeechProviders } from "../../tts/provider-registry.js";
import { getResolvedSpeechProviderConfig, resolveTtsConfig } from "../../tts/tts.js";
import {
  buildTalkRealtimeConfig,
  buildTalkTranscriptionConfig,
  configuredOrFalse,
  listTalkTranscriptionProviders,
  resolveConfiguredRealtimeTranscriptionProvider,
} from "./talk-shared.js";

function resolveCatalogProviderSelection(
  configuredProvider: string | undefined,
  resolveAutomaticProvider: () => string,
): { activeProvider?: string; ready: boolean } {
  // Provider priority belongs to the runtime resolver; catalog consumers must not infer it from row order.
  try {
    const resolvedProvider = resolveAutomaticProvider();
    return {
      activeProvider: resolvedProvider,
      ready: true,
    };
  } catch {
    return {
      ...(configuredProvider ? { activeProvider: configuredProvider } : {}),
      ready: false,
    };
  }
}

/** Advertise a provider pick-list only when non-empty; empty lists are omitted. */
function setProviderListEntry(
  entry: Record<string, unknown>,
  key: "models" | "aliases" | "voices",
  values: readonly string[] | undefined,
): void {
  if (values?.length) {
    entry[key] = [...values];
  }
}

export function buildTalkCatalog(config: OpenClawConfig) {
  const ttsConfig = resolveTtsConfig(config);
  const talkResolved = resolveActiveTalkProviderConfig(config.talk);
  const activeSpeechProvider = canonicalizeSpeechProviderId(talkResolved?.provider, config);
  const transcriptionConfig = buildTalkTranscriptionConfig(config);
  const transcriptionSelection = resolveCatalogProviderSelection(
    canonicalizeRealtimeTranscriptionProviderId(transcriptionConfig.provider, config),
    () =>
      resolveConfiguredRealtimeTranscriptionProvider({
        config,
        configuredProviderId: transcriptionConfig.provider,
        providerConfigs: transcriptionConfig.providers,
        defaultModel: transcriptionConfig.model,
      }).provider.id,
  );
  const activeTranscriptionProvider = transcriptionSelection.activeProvider;
  const realtimeConfig = buildTalkRealtimeConfig(config);
  const realtimeSelection = resolveCatalogProviderSelection(
    canonicalizeRealtimeVoiceProviderId(realtimeConfig.provider, config),
    () =>
      resolveConfiguredRealtimeVoiceProvider({
        cfg: config,
        configuredProviderId: realtimeConfig.provider,
        providerConfigs: realtimeConfig.providers,
        defaultModel: realtimeConfig.model,
      }).provider.id,
  );
  const activeRealtimeProvider = realtimeSelection.activeProvider;

  return {
    modes: ["realtime", "stt-tts", "transcription"],
    transports: ["webrtc", "provider-websocket", "gateway-relay", "managed-room"],
    brains: ["agent-consult", "direct-tools", "none"],
    speech: {
      ...(activeSpeechProvider ? { activeProvider: activeSpeechProvider } : {}),
      providers: listSpeechProviders(config).map((provider) => {
        const entry: Record<string, unknown> = {
          id: provider.id,
          label: provider.label,
          configured: configuredOrFalse(() =>
            provider.isConfigured({
              cfg: config,
              providerConfig: getResolvedSpeechProviderConfig(ttsConfig, provider.id, config),
              timeoutMs: ttsConfig.timeoutMs,
            }),
          ),
          modes: ["stt-tts"],
          brains: ["agent-consult"],
        };
        setProviderListEntry(entry, "models", provider.models);
        setProviderListEntry(entry, "aliases", provider.aliases);
        setProviderListEntry(entry, "voices", provider.voices);
        return entry;
      }),
    },
    transcription: {
      ready: transcriptionSelection.ready,
      ...(activeTranscriptionProvider ? { activeProvider: activeTranscriptionProvider } : {}),
      providers: listTalkTranscriptionProviders(config, [
        transcriptionConfig.provider,
        ...Object.keys(transcriptionConfig.providers),
      ]).map((provider) => {
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
          configured: configuredOrFalse(() =>
            provider.isConfigured({ cfg: config, providerConfig }),
          ),
          modes: ["transcription"],
          transports: ["gateway-relay"],
          brains: ["none"],
        };
        if (provider.defaultModel) {
          entry.defaultModel = provider.defaultModel;
        }
        setProviderListEntry(entry, "models", provider.models);
        setProviderListEntry(entry, "aliases", provider.aliases);
        return entry;
      }),
    },
    realtime: {
      ready: realtimeSelection.ready,
      ...(activeRealtimeProvider ? { activeProvider: activeRealtimeProvider } : {}),
      providers: listRealtimeVoiceProviders(config).map((provider) => {
        const rawConfig = resolveProviderRawConfig({
          providerConfigs: realtimeConfig.providers ?? {},
          providerId: provider.id,
          configuredProviderId:
            provider.id === activeRealtimeProvider ? realtimeConfig.provider : undefined,
        });
        const rawConfigWithModel =
          realtimeConfig.model && rawConfig.model === undefined
            ? { ...rawConfig, model: realtimeConfig.model }
            : rawConfig;
        const providerConfig =
          provider.resolveConfig?.({ cfg: config, rawConfig: rawConfigWithModel }) ??
          rawConfigWithModel;
        const capabilities = provider.capabilities;
        const entry: Record<string, unknown> = {
          id: provider.id,
          label: provider.label,
          configured: configuredOrFalse(() =>
            provider.isConfigured({ cfg: config, providerConfig }),
          ),
          modes: ["realtime"],
          brains: capabilities?.supportsToolCalls === false ? ["none"] : ["agent-consult"],
          supportsBrowserSession: Boolean(
            capabilities?.supportsBrowserSession ?? provider.createBrowserSession,
          ),
        };
        if (provider.defaultModel) {
          entry.defaultModel = provider.defaultModel;
        }
        setProviderListEntry(entry, "models", provider.models);
        setProviderListEntry(entry, "aliases", provider.aliases);
        setProviderListEntry(entry, "voices", provider.voices);
        if (capabilities?.transports) {
          entry.transports = [...capabilities.transports];
        }
        if (capabilities?.inputAudioFormats) {
          entry.inputAudioFormats = capabilities.inputAudioFormats.map((format) => ({ ...format }));
        }
        if (capabilities?.outputAudioFormats) {
          entry.outputAudioFormats = capabilities.outputAudioFormats.map((format) => ({
            ...format,
          }));
        }
        if (capabilities?.supportsBargeIn !== undefined) {
          entry.supportsBargeIn = capabilities.supportsBargeIn;
        }
        if (capabilities?.supportsToolCalls !== undefined) {
          entry.supportsToolCalls = capabilities.supportsToolCalls;
        }
        if (capabilities?.supportsVideoFrames !== undefined) {
          entry.supportsVideoFrames = capabilities.supportsVideoFrames;
        }
        if (capabilities?.supportsSessionResumption !== undefined) {
          entry.supportsSessionResumption = capabilities.supportsSessionResumption;
        }
        return entry;
      }),
    },
  };
}
