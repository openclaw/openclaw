import { isRecord } from "@openclaw/normalization-core/record-coerce";

export function readOverrideRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    return {};
  }
  const overrides: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (key.trim()) {
      overrides[key] = raw;
    }
  }
  return overrides;
}

export function filterUnsupportedManagedNpmRootOverrides(
  value: unknown,
  omitNpmAliases = false,
): Record<string, unknown> {
  const overrides = readOverrideRecord(value);
  const filtered: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(overrides)) {
    if (
      // Match pnpm's delimiter without confusing npm ranges such as pkg@>1.
      /[^ |@]>/u.test(key) ||
      (omitNpmAliases && typeof raw === "string" && raw.trim().startsWith("npm:"))
    ) {
      continue;
    }
    if (isRecord(raw)) {
      const nested = filterUnsupportedManagedNpmRootOverrides(raw, omitNpmAliases);
      if (Object.keys(nested).length > 0) {
        filtered[key] = nested;
      }
      continue;
    }
    filtered[key] = raw;
  }
  return filtered;
}
