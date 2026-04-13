import { parseStrictNonNegativeInteger } from "../../infra/parse-finite-number.js";

export const DEFAULT_SESSION_OBJECT_CACHE_MAX_BYTES = 1_000_000;
export const SESSION_OBJECT_CACHE_MAX_BYTES_ENV = "OPENCLAW_SESSION_OBJECT_CACHE_MAX_BYTES";

export function resolveSessionObjectCacheMaxBytes(
  envValue = process.env.OPENCLAW_SESSION_OBJECT_CACHE_MAX_BYTES,
): number {
  const parsed = parseStrictNonNegativeInteger(envValue);
  return parsed ?? DEFAULT_SESSION_OBJECT_CACHE_MAX_BYTES;
}
