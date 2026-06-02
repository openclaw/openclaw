import { normalizeTrimmedStringList } from "@openclaw/normalization-core/string-normalization";

/**
 * Normalize optional gateway URL-input hostname allowlists for OpenAI-compatible requests.
 * Missing or whitespace-only lists mean unrestricted hostnames; callers that
 * need deny-all URL fetching must use the owning `allowUrl: false` switch.
 */
export function normalizeInputHostnameAllowlist(
  values: string[] | undefined,
): string[] | undefined {
  if (!values || values.length === 0) {
    return undefined;
  }
  const normalized = normalizeTrimmedStringList(values);
  return normalized.length > 0 ? normalized : undefined;
}
