/** Prefix numeric versions; preserve existing prefixes and build names. */
export function formatVersionLabel(raw: string): string {
  const trimmed = raw.trim();
  return /^\d/.test(trimmed) ? `v${trimmed}` : trimmed || raw;
}
