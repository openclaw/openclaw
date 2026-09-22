// Skill filter helpers apply config, agent, and source filters to discovered skills.
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";

/** Normalizes an optional skill filter while preserving undefined as "not configured". */
export function normalizeSkillFilter(skillFilter?: ReadonlyArray<unknown>): string[] | undefined {
  if (skillFilter === undefined) {
    return undefined;
  }
  return normalizeStringEntries(skillFilter);
}

function normalizeSkillFilterForComparison(
  skillFilter?: ReadonlyArray<unknown>,
): ReadonlySet<string> | undefined {
  const normalized = normalizeSkillFilter(skillFilter);
  if (normalized === undefined) {
    return undefined;
  }
  return new Set(normalized);
}

export function matchesSkillFilter(
  cached?: ReadonlyArray<unknown>,
  next?: ReadonlyArray<unknown>,
): boolean {
  const cachedNormalized = normalizeSkillFilterForComparison(cached);
  const nextNormalized = normalizeSkillFilterForComparison(next);
  if (cachedNormalized === undefined || nextNormalized === undefined) {
    return cachedNormalized === nextNormalized;
  }
  if (cachedNormalized.size !== nextNormalized.size) {
    return false;
  }
  for (const entry of cachedNormalized) {
    if (!nextNormalized.has(entry)) {
      return false;
    }
  }
  return true;
}
