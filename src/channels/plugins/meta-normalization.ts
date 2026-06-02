import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { ChannelMeta } from "./types.public.js";

function stripRequiredChannelMeta(meta?: Partial<ChannelMeta> | null) {
  const {
    id: _ignoredId,
    label: _ignoredLabel,
    selectionLabel: _ignoredSelectionLabel,
    docsPath: _ignoredDocsPath,
    blurb: _ignoredBlurb,
    ...rest
  } = meta ?? {};
  return rest;
}

/**
 * Produces a complete channel meta object from plugin-provided and manifest
 * metadata, preserving optional fields while recalculating required labels.
 */
export function normalizeChannelMeta<TId extends string>(params: {
  id: TId;
  meta?: Partial<ChannelMeta> | null;
  existing?: Partial<ChannelMeta> | null;
}): ChannelMeta & { id: TId } {
  const next = params.meta ?? undefined;
  const existing = params.existing ?? undefined;
  const label =
    normalizeOptionalString(next?.label) ??
    normalizeOptionalString(existing?.label) ??
    normalizeOptionalString(next?.selectionLabel) ??
    normalizeOptionalString(existing?.selectionLabel) ??
    params.id;
  const selectionLabel =
    normalizeOptionalString(next?.selectionLabel) ??
    normalizeOptionalString(existing?.selectionLabel) ??
    label;
  const docsPath =
    normalizeOptionalString(next?.docsPath) ??
    normalizeOptionalString(existing?.docsPath) ??
    `/channels/${params.id}`;
  const blurb =
    normalizeOptionalString(next?.blurb) ?? normalizeOptionalString(existing?.blurb) ?? "";

  return {
    // Required fields are rebuilt below so partial plugin metadata cannot leave
    // stale manifest labels/docs attached to a different channel id.
    ...stripRequiredChannelMeta(existing),
    ...stripRequiredChannelMeta(next),
    id: params.id,
    label,
    selectionLabel,
    docsPath,
    blurb,
  } as ChannelMeta & { id: TId };
}
