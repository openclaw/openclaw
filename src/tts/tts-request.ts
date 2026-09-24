import type { OpenClawConfig, TtsConfig } from "../config/types.js";
import { mergeDeep } from "../infra/deep-merge.js";
import {
  resolvePluginCapabilityProvider,
  resolvePluginCapabilityProviders,
} from "../plugins/capability-provider-runtime.js";
import { createLegacyPluginSdkProviderProjection } from "../plugins/legacy-sdk-provider-projection.js";
import { getLegacyPluginSdkResourceHost } from "../plugins/legacy-sdk-resource-host.js";
import { parseTtsDirectives } from "./directives.js";
import { createSpeechProviderRegistry } from "./provider-registry-core.js";
import { canonicalizeSpeechProviderId, getSpeechProvider } from "./provider-registry.js";
import type {
  SpeechProviderOverrides,
  TtsDirectiveOverrides,
  TtsDirectiveParseResult,
} from "./provider-types.js";
import { resolveTtsProvider } from "./tts-provider-resolution.js";
import { resolveTtsConfig, resolveTtsPrefsPath, resolveTtsRuntimeConfig } from "./tts-settings.js";

type PreparedTtsRequest = {
  cfg: OpenClawConfig;
  directives: TtsDirectiveParseResult;
};

/** Merge a surface TTS override and resolve its inline synthesis directives. */
export async function prepareTtsRequest(params: {
  cfg: OpenClawConfig;
  override?: TtsConfig;
  text: string;
}): Promise<PreparedTtsRequest> {
  const host = getLegacyPluginSdkResourceHost();
  return await host.track(() => {
    using projection = createLegacyPluginSdkProviderProjection();
    const retain = (registry: Parameters<typeof projection.select>[0]) => {
      const project = projection.select(registry);
      // Failed directive projections can leave tails; the host owns them before metadata runs.
      projection.adopt();
      return project;
    };
    const registry = createSpeechProviderRegistry({
      getProvider: (providerId, cfg) =>
        resolvePluginCapabilityProvider({ key: "speechProviders", providerId, cfg }, retain),
      listProviders: (cfg) =>
        resolvePluginCapabilityProviders({ key: "speechProviders", cfg }, retain),
    });
    const cfg = params.override
      ? {
          ...params.cfg,
          tts: mergeDeep(params.cfg.tts ?? {}, params.override) as TtsConfig,
        }
      : params.cfg;
    const config = resolveTtsConfig(cfg);
    const directives = parseTtsDirectives(params.text, config.modelOverrides, {
      cfg,
      get providers() {
        return registry.listSpeechProviders(cfg);
      },
      providerConfigs: config.providerConfigs,
      preferredProviderId: resolveTtsProvider(config, resolveTtsPrefsPath(config), registry),
    });
    host.assertOpen();
    return { cfg, directives };
  });
}

export function resolveExplicitTtsOverrides(params: {
  cfg: OpenClawConfig;
  prefsPath?: string;
  provider?: string;
  modelId?: string;
  voiceId?: string;
  agentId?: string;
  channelId?: string;
  accountId?: string;
}): TtsDirectiveOverrides {
  const cfg = resolveTtsRuntimeConfig(params.cfg);
  const providerInput = params.provider?.trim();
  const modelId = params.modelId?.trim();
  const voiceId = params.voiceId?.trim();
  const config = resolveTtsConfig(cfg, {
    agentId: params.agentId,
    channelId: params.channelId,
    accountId: params.accountId,
  });
  const prefsPath = params.prefsPath ?? resolveTtsPrefsPath(config);
  const selectedProvider =
    canonicalizeSpeechProviderId(providerInput, cfg) ??
    (modelId || voiceId ? resolveTtsProvider(config, prefsPath) : undefined);

  if (providerInput && !selectedProvider) {
    throw new Error(`Unknown TTS provider "${providerInput}".`);
  }

  if (!modelId && !voiceId) {
    return selectedProvider ? { provider: selectedProvider } : {};
  }

  if (!selectedProvider) {
    throw new Error("TTS model or voice overrides require a resolved provider.");
  }

  const provider = getSpeechProvider(selectedProvider, cfg);
  if (!provider) {
    throw new Error(`speech provider ${selectedProvider} is not registered`);
  }
  if (!provider.resolveTalkOverrides) {
    throw new Error(
      `TTS provider "${selectedProvider}" does not support model or voice overrides.`,
    );
  }

  const providerOverrides = provider.resolveTalkOverrides({
    talkProviderConfig: {},
    params: {
      ...(voiceId ? { voiceId } : {}),
      ...(modelId ? { modelId } : {}),
    },
  });
  if ((voiceId || modelId) && (!providerOverrides || Object.keys(providerOverrides).length === 0)) {
    throw new Error(
      `TTS provider "${selectedProvider}" ignored the requested model or voice overrides.`,
    );
  }

  const overridesRecord = providerOverrides as SpeechProviderOverrides;
  return {
    provider: selectedProvider,
    providerOverrides: {
      [provider.id]: overridesRecord,
    },
  };
}
