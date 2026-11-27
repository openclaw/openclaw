import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { ChannelMeta } from "./types.public.js";

export function normalizeChannelMeta<TId extends string>(params: {
  id: TId;
  meta?: Partial<ChannelMeta> | null;
  existing?: Partial<ChannelMeta> | null;
}): ChannelMeta & { id: TId } {
  const next = params.meta;
  const existing = params.existing;
  const label = normalizeOptionalString(next?.label) ?? normalizeOptionalString(existing?.label);
  const selectionLabel =
    normalizeOptionalString(next?.selectionLabel) ??
    normalizeOptionalString(existing?.selectionLabel);
  const docsPath =
    normalizeOptionalString(next?.docsPath) ??
    normalizeOptionalString(existing?.docsPath) ??
    `/channels/${params.id}`;
  const blurb =
    normalizeOptionalString(next?.blurb) ?? normalizeOptionalString(existing?.blurb) ?? "";

  return {
    ...existing,
    ...next,
    id: params.id,
    label: label ?? selectionLabel ?? params.id,
    selectionLabel: selectionLabel ?? label ?? params.id,
    docsPath,
    blurb,
  };
}
