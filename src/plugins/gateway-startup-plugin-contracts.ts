// Shared contracts for Gateway startup plugin collection and planning.
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
export function sortUniquePluginIds(values: Iterable<string>): string[] {
  return [...new Set([...values].map((value) => value.trim()).filter(Boolean))].toSorted(
    (left, right) => left.localeCompare(right),
  );
}
