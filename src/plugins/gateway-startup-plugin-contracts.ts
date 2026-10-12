import { isRecord } from "@openclaw/normalization-core/record-coerce";

export type { NormalizedPluginsConfig } from "./config-normalization-shared.js";

export type GatewayStartupPluginPlan = {
  channelPluginIds: readonly string[];
  pluginIds: readonly string[];
};

type GenerationProviderContractKey =
  | "imageGenerationProviders"
  | "videoGenerationProviders"
  | "musicGenerationProviders";
type VoiceProviderContractKey =
  | "speechProviders"
  | "realtimeTranscriptionProviders"
  | "realtimeVoiceProviders";
export type ConfiguredGenerationProviderIds = Record<
  GenerationProviderContractKey,
  ReadonlySet<string>
>;
export type ConfiguredVoiceProviderIds = Record<VoiceProviderContractKey, ReadonlySet<string>>;

export function isConfigActivationValueEnabled(value: unknown): boolean {
  return value !== false && !(isRecord(value) && value.enabled === false);
}

export function sortUniquePluginIds(values: Iterable<string>): string[] {
  return [...new Set([...values].map((value) => value.trim()).filter(Boolean))].toSorted(
    (left, right) => left.localeCompare(right),
  );
}
