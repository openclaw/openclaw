import { isBlockedObjectKey } from "../infra/prototype-keys.js";

export const DEFAULT_ACCOUNT_ID = "default";

const VALID_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const INVALID_CHARS_RE = /[^a-z0-9_-]+/g;
const LEADING_DASH_RE = /^-+/;
const TRAILING_DASH_RE = /-+$/;

function canonicalizeAccountId(value: string): string {
  if (VALID_ID_RE.test(value)) {
    return value.toLowerCase();
  }
  return value
    .toLowerCase()
    .replace(INVALID_CHARS_RE, "-")
    .replace(LEADING_DASH_RE, "")
    .replace(TRAILING_DASH_RE, "")
    .slice(0, 64);
}

function normalizeCanonicalAccountId(value: string): string | undefined {
  const canonical = canonicalizeAccountId(value);
  if (!canonical || isBlockedObjectKey(canonical)) {
    return undefined;
  }
  return canonical;
}

export function normalizeAccountId(value: string | undefined | null): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed) {
    return DEFAULT_ACCOUNT_ID;
  }
  return normalizeCanonicalAccountId(trimmed) || DEFAULT_ACCOUNT_ID;
}

export function normalizeOptionalAccountId(value: string | undefined | null): string | undefined {
  const trimmed = (value ?? "").trim();
  if (!trimmed) {
    return undefined;
  }
  return normalizeCanonicalAccountId(trimmed) || undefined;
}
