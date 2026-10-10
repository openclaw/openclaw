import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { ChannelMeta } from "./types.public.js";

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
    ...existing,
    ...next,
    id: params.id,
    label,
    selectionLabel,
    docsPath,
    blurb,
  };
}
