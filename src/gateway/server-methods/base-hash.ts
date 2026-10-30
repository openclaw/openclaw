import { normalizeNullableString } from "@openclaw/normalization-core/string-coerce";

/** Read the optional optimistic-write base hash from a gateway method payload. */
export function resolveBaseHashParam(params: unknown): string | null {
  return normalizeNullableString((params as { baseHash?: unknown })?.baseHash);
}
