import type {
  UnifiedModelCatalogEntry,
  UnifiedModelCatalogKind,
  UnifiedModelCatalogSource,
} from "../model-catalog/types.js";
import { normalizeUniqueSingleOrTrimmedStringList } from "../shared/string-normalization.js";

export type VoiceModelCatalogKind = Extract<UnifiedModelCatalogKind, "voice">;

export type VoiceModelCapability = "tts" | "realtime_transcription" | "realtime_voice";

export type VoiceModelCapabilities = Partial<Record<VoiceModelCapability, true>>;

export type VoiceModelCatalogSource = Extract<
  UnifiedModelCatalogSource,
  "static" | "live" | "cache" | "configured"
>;

export type VoiceModelCatalogEntry = UnifiedModelCatalogEntry<VoiceModelCapabilities> & {
  kind: VoiceModelCatalogKind;
  source: VoiceModelCatalogSource;
};

export type VoiceModelCatalogProvider = {
  id: string;
  label?: string;
  defaultModel?: string;
  models?: readonly string[];
};

function uniqueModels(provider: Pick<VoiceModelCatalogProvider, "defaultModel" | "models">) {
  return normalizeUniqueSingleOrTrimmedStringList([
    provider.defaultModel,
    ...(provider.models ?? []),
  ]);
}

export function synthesizeVoiceModelCatalogEntries(params: {
  provider: VoiceModelCatalogProvider;
  capabilities: VoiceModelCapabilities;
  modes?: readonly string[];
}): VoiceModelCatalogEntry[] {
  return uniqueModels(params.provider).map((model) => {
    const entry: VoiceModelCatalogEntry = {
      kind: "voice",
      provider: params.provider.id,
      model,
      source: "static",
      capabilities: params.capabilities,
    };
    if (params.provider.label) {
      entry.label = params.provider.label;
    }
    if (model === params.provider.defaultModel) {
      entry.default = true;
    }
    if (params.modes) {
      entry.modes = params.modes;
    }
    return entry;
  });
}
