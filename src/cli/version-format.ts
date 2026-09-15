/** Prefix numeric version labels once; preserve existing prefixes and build labels. */
export function formatVersionLabel(raw: string): string {
  const trimmed = raw.trim();
  return /^\d/.test(trimmed) ? `v${trimmed}` : trimmed || raw;
}
