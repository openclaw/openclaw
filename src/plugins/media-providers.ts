import type { MediaUnderstandingProvider } from "../media-understanding/types.js";
import { getActivePluginRegistry } from "./runtime.js";

/**
 * Collect media understanding providers registered by plugins into a
 * record suitable for passing as the `providers` override to
 * `applyMediaUnderstanding` / `runAudioTranscription`.
 */
export function getPluginMediaProviders(): Record<string, MediaUnderstandingProvider> | undefined {
  const registry = getActivePluginRegistry();
  const entries = registry?.mediaProviders ?? [];
  if (!entries.length) {
    return undefined;
  }
  const result: Record<string, MediaUnderstandingProvider> = {};
  for (const entry of entries) {
    result[entry.provider.id] = entry.provider;
  }
  return result;
}
