import { isRecord } from "@openclaw/normalization-core/record-coerce";

export type { NormalizedPluginsConfig } from "./config-normalization-shared.js";

export type GatewayStartupPluginPlan = {
  channelPluginIds: readonly string[];
  pluginIds: readonly string[];
};

export type ConfiguredGenerationProviderIds = Record<
  "imageGenerationProviders" | "videoGenerationProviders" | "musicGenerationProviders",
  ReadonlySet<string>
>;
export type ConfiguredVoiceProviderIds = Record<
  "speechProviders" | "realtimeTranscriptionProviders" | "realtimeVoiceProviders",
  ReadonlySet<string>
>;

export function isConfigActivationValueEnabled(value: unknown): boolean {
  return value !== false && !(isRecord(value) && value.enabled === false);
}

export function sortUniquePluginIds(values: Iterable<string>): string[] {
  return [...new Set([...values].map((value) => value.trim()).filter(Boolean))].toSorted(
    (left, right) => left.localeCompare(right),
  );
}
