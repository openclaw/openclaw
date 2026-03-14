import type {
  AudioTranscriptionRequest,
  AudioTranscriptionResult,
  MediaUnderstandingProvider,
} from "../media-understanding/types.js";
import type { AsrEngine } from "./engine.js";
import type { AsrEngineRegistry } from "./registry.js";

/**
 * Wrap an {@link AsrEngine} so it can be used wherever a
 * `MediaUnderstandingProvider.transcribeAudio` callback is expected.
 *
 * This allows the existing `media-understanding` runner to call through
 * the new `AsrEngine` abstraction without any changes to the runner itself.
 */
export function asrEngineToTranscribeAudioFn(
  engine: AsrEngine,
): (req: AudioTranscriptionRequest) => Promise<AudioTranscriptionResult> {
  return (req) => engine.transcribe(req);
}

/**
 * Create a `MediaUnderstandingProvider` backed by an {@link AsrEngine}.
 *
 * The returned provider only exposes the `transcribeAudio` method.
 * `capabilities` is intentionally omitted so that, when used as an override
 * in `buildMediaUnderstandingRegistry`, the existing provider's full
 * capability list (which may include image/video) is preserved via the
 * `capabilities: provider.capabilities ?? existing.capabilities` merge path.
 */
export function asrEngineToMediaProvider(engine: AsrEngine): MediaUnderstandingProvider {
  return {
    id: engine.id,
    transcribeAudio: asrEngineToTranscribeAudioFn(engine),
  };
}

/**
 * Bulk-convert an {@link AsrEngineRegistry} into a record of
 * `MediaUnderstandingProvider` objects keyed by normalised engine ID.
 *
 * This can be fed directly into the existing
 * `buildMediaUnderstandingRegistry(overrides)` call so that every registered
 * ASR engine transparently replaces (or supplements) the hardcoded providers.
 */
export function asrRegistryToMediaProviders(
  registry: AsrEngineRegistry,
): Record<string, MediaUnderstandingProvider> {
  const result: Record<string, MediaUnderstandingProvider> = {};
  for (const [id, engine] of registry) {
    result[id] = asrEngineToMediaProvider(engine);
  }
  return result;
}
