/**
 * Normalize optional gateway URL-input hostname allowlists.
 *
 * Semantics are intentionally:
 * - missing list => no hostname allowlist restriction
 * - explicit empty / fully trimmed-empty list => deny all URL fetches
 */
export function normalizeInputHostnameAllowlist(
  values: string[] | undefined,
): string[] | undefined {
  if (values === undefined) {
    return undefined;
  }
  if (values.length === 0) {
    return [];
  }
  return values.map((value) => value.trim()).filter((value) => value.length > 0);
}
