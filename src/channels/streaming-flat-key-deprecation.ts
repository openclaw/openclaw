// Flat-key compatibility resolvers and warn-once state. This module keeps the
// test-only reset and warning helpers off the public SDK wildcard surface.
import type {
  BlockStreamingChunkConfig,
  BlockStreamingCoalesceConfig,
  ChannelStreamingConfig,
  TextChunkMode,
} from "../config/types.base.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { asBoolean } from "../utils/boolean.js";
import type { StreamingCompatEntry } from "./streaming.js";

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

function asObjectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asTextChunkMode(value: unknown): TextChunkMode | undefined {
  return value === "length" || value === "newline" ? value : undefined;
}

function asBlockStreamingCoalesceConfig(value: unknown): BlockStreamingCoalesceConfig | undefined {
  return (asObjectRecord(value) as BlockStreamingCoalesceConfig | null) ?? undefined;
}

function asBlockStreamingChunkConfig(value: unknown): BlockStreamingChunkConfig | undefined {
  return (asObjectRecord(value) as BlockStreamingChunkConfig | null) ?? undefined;
}

// This local read avoids a cycle with streaming.ts. It dies with this module
// on the fallback removal train.
function getChannelStreamingConfigObject(
  entry: StreamingCompatEntry | null | undefined,
): ChannelStreamingConfig | undefined {
  const streaming = asObjectRecord(entry?.streaming);
  return streaming ? (streaming as ChannelStreamingConfig) : undefined;
}

function resolveWithFlatFallback<T>(params: {
  nested: T | undefined;
  flat: T | undefined;
  flatKey: string;
  nestedPath: string;
}): T | undefined {
  if (params.nested !== undefined) {
    return params.nested;
  }
  if (params.flat !== undefined) {
    warnFlatStreamingKeyFallback(params.flatKey, params.nestedPath);
  }
  return params.flat;
}

export function resolveChannelStreamingChunkMode(
  entry: StreamingCompatEntry | null | undefined,
): TextChunkMode | undefined {
  return resolveWithFlatFallback({
    nested: asTextChunkMode(getChannelStreamingConfigObject(entry)?.chunkMode),
    flat: asTextChunkMode(entry?.chunkMode),
    flatKey: "chunkMode",
    nestedPath: "chunkMode",
  });
}

export function resolveChannelStreamingBlockEnabled(
  entry: StreamingCompatEntry | null | undefined,
): boolean | undefined {
  return resolveWithFlatFallback({
    nested: asBoolean(getChannelStreamingConfigObject(entry)?.block?.enabled),
    flat: asBoolean(entry?.blockStreaming),
    flatKey: "blockStreaming",
    nestedPath: "block.enabled",
  });
}

export function resolveChannelStreamingBlockCoalesce(
  entry: StreamingCompatEntry | null | undefined,
): BlockStreamingCoalesceConfig | undefined {
  return resolveWithFlatFallback({
    nested: asBlockStreamingCoalesceConfig(getChannelStreamingConfigObject(entry)?.block?.coalesce),
    flat: asBlockStreamingCoalesceConfig(entry?.blockStreamingCoalesce),
    flatKey: "blockStreamingCoalesce",
    nestedPath: "block.coalesce",
  });
}

export function resolveChannelStreamingPreviewChunk(
  entry: StreamingCompatEntry | null | undefined,
): BlockStreamingChunkConfig | undefined {
  return resolveWithFlatFallback({
    nested: asBlockStreamingChunkConfig(getChannelStreamingConfigObject(entry)?.preview?.chunk),
    flat: asBlockStreamingChunkConfig(entry?.draftChunk),
    flatKey: "draftChunk",
    nestedPath: "preview.chunk",
  });
}
