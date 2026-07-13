// Warn-once state for deprecated streaming config fallbacks in streaming.ts.
// Lives outside streaming.ts so the test-only reset stays off the public SDK
// surface (openclaw/plugin-sdk/channel-outbound re-exports all of streaming.ts).
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("channels/streaming");
const warnedStreamingFallbacks = new Set<string>();

/** @internal Test-only reset for the streaming config deprecation warning cache. */
export function resetStreamingDeprecationWarningsForTest(): void {
  warnedStreamingFallbacks.clear();
}

/** Warns once per process per flat key when a resolver used the flat fallback. */
export function warnFlatStreamingKeyFallback(flatKey: string, nestedPath: string): void {
  const warningKey = `flat:${flatKey}`;
  if (warnedStreamingFallbacks.has(warningKey)) {
    return;
  }
  warnedStreamingFallbacks.add(warningKey);
  log.warn(
    `Flat channel streaming key "${flatKey}" is deprecated; move it to streaming.${nestedPath}. The flat fallback is removed after the next release train.`,
  );
}

/** Warns once per process when a resolver used the scalar streaming fallback. */
export function warnScalarStreamingFallback(): void {
  const warningKey = "scalar:streaming";
  if (warnedStreamingFallbacks.has(warningKey)) {
    return;
  }
  warnedStreamingFallbacks.add(warningKey);
  log.warn(
    'Scalar channel streaming is deprecated; move it to streaming.mode. For booleans, replace true with "partial" (or the channel default) and false with "off". The scalar fallback is removed after the next release train.',
  );
}
