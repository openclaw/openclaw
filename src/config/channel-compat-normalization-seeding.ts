// Account streaming seeding helpers for config compatibility migrations.
import { asObjectRecord } from "./channel-compat-records.js";

/**
 * Root flat delivery aliases resolved per-key for every account (nested-first,
 * flat-fallback), even when the account carried its own `streaming` value that
 * replaces the root object wholesale at merge time. Capture them before root
 * migration so replace-semantics channels can seed existing account streaming
 * objects with the delivery settings those accounts previously inherited.
 */
export function buildRootFlatDeliverySeed(
  entry: Record<string, unknown>,
  includePreviewChunk: boolean | undefined,
): Record<string, unknown> | null {
  const seed: Record<string, unknown> = {};
  if (entry.chunkMode !== undefined) {
    seed.chunkMode = entry.chunkMode;
  }
  const block: Record<string, unknown> = {};
  if (entry.blockStreaming !== undefined) {
    block.enabled = entry.blockStreaming;
  }
  if (entry.blockStreamingCoalesce !== undefined) {
    block.coalesce = entry.blockStreamingCoalesce;
  }
  if (Object.keys(block).length > 0) {
    seed.block = block;
  }
  if (includePreviewChunk === true && entry.draftChunk !== undefined) {
    seed.preview = { chunk: entry.draftChunk };
  }
  return Object.keys(seed).length > 0 ? seed : null;
}

/**
 * Rebuilds a materialized account streaming object with the per-slot
 * precedence the runtime resolvers applied pre-migration. The slots disagree:
 * - mode, block.enabled, preview.chunk resolve on the MERGED entry
 *   (src/channels/streaming.ts nested-first), so the root nested object
 *   outranked account flat aliases and preview.chunk picks atomically.
 * - chunkMode resolves the raw account entry before the root entry
 *   (resolveChunkModeForProvider in src/auto-reply/chunk.ts), so an account
 *   flat chunkMode outranked every root spelling.
 * - block.coalesce merges the account pick over the root pick per field
 *   (resolveProviderBlockStreamingCoalesce in
 *   src/auto-reply/reply/block-streaming.ts).
 * One generic deep-fill cannot express that ladder, so seed slot by slot.
 * Copying root values freezes inheritance at fix time by design (the change
 * message records it); merged-entry channels (mattermost-style resolved
 * accounts) would otherwise lose the root values entirely once the account
 * owns a streaming object.
 */
export function seedMaterializedAccountStreaming(params: {
  created: Record<string, unknown>;
  rootNestedBefore: Record<string, unknown> | null;
  rootFlat: Record<string, unknown> | null;
  rootAfter: Record<string, unknown>;
}): Record<string, unknown> {
  const { created } = params;
  const rootNested = params.rootNestedBefore ?? {};
  const rootFlat = params.rootFlat ?? {};
  // Root-first base for the merged-entry slots plus inherited root extras
  // (progress, preview.toolProgress, ...). Account values fill the gaps.
  let seeded = fillMissingRecordFields(structuredClone(rootNested), created).value;
  seeded = fillMissingRecordFields(seeded, rootFlat).value;
  // Root migration can add fields the pre-migration snapshot lacked (mode
  // restored from root streamMode/scalar aliases); the account previously
  // inherited the root object wholesale, so it inherits the restored intent.
  seeded = fillMissingRecordFields(seeded, params.rootAfter).value;
  // chunkMode: account-entry-first resolver, so the account alias wins.
  if (created.chunkMode !== undefined) {
    seeded = { ...seeded, chunkMode: created.chunkMode };
  }
  // block.coalesce: account fields merge over the root pick per field.
  const createdCoalesce = asObjectRecord(asObjectRecord(created.block)?.coalesce);
  if (createdCoalesce) {
    const rootCoalesce =
      asObjectRecord(asObjectRecord(rootNested.block)?.coalesce) ??
      asObjectRecord(asObjectRecord(rootFlat.block)?.coalesce);
    seeded = {
      ...seeded,
      block: {
        ...asObjectRecord(seeded.block),
        coalesce: { ...structuredClone(rootCoalesce ?? {}), ...structuredClone(createdCoalesce) },
      },
    };
  }
  // preview.chunk: merged-entry resolver picks the whole object atomically, so
  // never blend a root nested chunk with an account draftChunk-derived one.
  const rootNestedPreviewChunk = asObjectRecord(rootNested.preview)?.chunk;
  if (
    rootNestedPreviewChunk !== undefined &&
    asObjectRecord(created.preview)?.chunk !== undefined
  ) {
    seeded = {
      ...seeded,
      preview: {
        ...asObjectRecord(seeded.preview),
        chunk: structuredClone(rootNestedPreviewChunk),
      },
    };
  }
  return seeded;
}

/** Deep-fills record fields missing from target with copies of source values. */
function fillMissingRecordFields(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): { value: Record<string, unknown>; filled: boolean } {
  let filled = false;
  const value = { ...target };
  for (const [key, sourceValue] of Object.entries(source)) {
    if (sourceValue === undefined) {
      continue;
    }
    const existing = value[key];
    if (existing === undefined) {
      // Copy so later account-level edits never alias the root config object.
      value[key] = structuredClone(sourceValue);
      filled = true;
      continue;
    }
    const existingRecord = asObjectRecord(existing);
    const sourceRecord = asObjectRecord(sourceValue);
    if (!existingRecord || !sourceRecord) {
      continue;
    }
    const merged = fillMissingRecordFields(existingRecord, sourceRecord);
    if (merged.filled) {
      value[key] = merged.value;
      filled = true;
    }
  }
  return { value, filled };
}
