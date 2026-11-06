import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";

/** Normalizes an optional skill filter while preserving undefined as "not configured". */
export function normalizeSkillFilter(skillFilter?: ReadonlyArray<unknown>): string[] | undefined {
  if (skillFilter === undefined) {
    return undefined;
  }
  return normalizeStringEntries(skillFilter);
}

export function matchesSkillFilter(
  cached?: ReadonlyArray<unknown>,
  next?: ReadonlyArray<unknown>,
): boolean {
  const cachedNormalized = normalizeSkillFilter(cached);
  const nextNormalized = normalizeSkillFilter(next);
  if (cachedNormalized === undefined || nextNormalized === undefined) {
    return cachedNormalized === nextNormalized;
  }
  const nextEntries = new Set(nextNormalized);
  return (
    new Set(cachedNormalized).size === nextEntries.size &&
    cachedNormalized.every((entry) => nextEntries.has(entry))
  );
}
