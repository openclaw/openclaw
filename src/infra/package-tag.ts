import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

/** Normalize update target input by stripping known package-name prefixes from tags. */
export function normalizePackageTagInput(
  value: string | undefined | null,
  packageNames: readonly string[],
): string | null {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return null;
  }

  for (const packageName of packageNames) {
    if (trimmed === packageName) {
      return null;
    }
    const prefix = `${packageName}@`;
    if (trimmed.startsWith(prefix)) {
      // `openclaw@` means "no explicit tag"; later @ signs remain part of the tag.
      const tag = trimmed.slice(prefix.length).trim();
      return tag ? tag : null;
    }
  }

  return trimmed;
}
