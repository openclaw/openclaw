import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { parseRegistryNpmSpec } from "./npm-registry-spec.js";

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
  // pnpm's exact-parent child rules have an npm equivalent. Keep other pnpm
  // selectors unsupported rather than widening them into global overrides.
  // Merge after ordinary rules so input order cannot discard sibling children
  // or the parent's own replacement (npm's "." entry).
  for (const [key, raw] of Object.entries(overrides)) {
    if (typeof raw !== "string" || (omitNpmAliases && raw.trim().startsWith("npm:"))) {
      continue;
    }
    const [parentSelector, childSelector, extra] = key.split(">");
    if (!parentSelector || !childSelector || extra !== undefined) {
      continue;
    }
    const parent = parseRegistryNpmSpec(parentSelector);
    const child = parseRegistryNpmSpec(childSelector);
    if (parent?.selectorKind !== "exact-version" || child?.selectorKind !== "none") {
      continue;
    }
    const existing = filtered[parent.raw];
    filtered[parent.raw] = {
      ...(isRecord(existing) ? existing : typeof existing === "string" ? { ".": existing } : {}),
      [child.name]: raw,
    };
  }
  return filtered;
}
