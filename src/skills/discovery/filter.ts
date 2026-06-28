// Skill filter helpers apply config, agent, and source filters to discovered skills.
import {
  normalizeStringEntries,
  sortUniqueStrings,
} from "@openclaw/normalization-core/string-normalization";

/** Normalizes an optional skill filter while preserving undefined as "not configured". */
export function normalizeSkillFilter(skillFilter?: ReadonlyArray<unknown>): string[] | undefined {
  if (skillFilter === undefined) {
    return undefined;
  }
  return normalizeStringEntries(skillFilter);
}

export type SkillFilterMergeShape = {
  add?: ReadonlyArray<unknown>;
  remove?: ReadonlyArray<unknown>;
};

function hasOwnProperty(value: object, key: string): boolean {
  return Object.hasOwn(value, key);
}

/** Applies an add/remove delta to an inherited skill filter while preserving allowlist semantics. */
export function mergeSkillFilter(
  inheritedFilter: ReadonlyArray<unknown> | undefined,
  mergeConfig: SkillFilterMergeShape | undefined,
): string[] | undefined {
  const inherited = normalizeSkillFilter(inheritedFilter);
  if (!mergeConfig) {
    return inherited;
  }
  if (inherited === undefined) {
    return undefined;
  }

  const remove = new Set(normalizeSkillFilter(mergeConfig.remove) ?? []);
  const merged = inherited.filter((skill) => !remove.has(skill));
  for (const skill of normalizeSkillFilter(mergeConfig.add) ?? []) {
    if (!remove.has(skill) && !merged.includes(skill)) {
      merged.push(skill);
    }
  }
  return merged;
}

/** Resolves a scope's effective skill filter from replacement or inherited merge config. */
export function resolveComposedSkillFilter(
  scopeConfig:
    | {
        skills?: ReadonlyArray<unknown>;
        skillsMerge?: SkillFilterMergeShape;
      }
    | undefined,
  inheritedFilter?: ReadonlyArray<unknown>,
): string[] | undefined {
  if (scopeConfig && hasOwnProperty(scopeConfig, "skills")) {
    return normalizeSkillFilter(scopeConfig.skills);
  }
  return mergeSkillFilter(inheritedFilter, scopeConfig?.skillsMerge);
}

export function normalizeSkillFilterForComparison(
  skillFilter?: ReadonlyArray<unknown>,
): string[] | undefined {
  const normalized = normalizeSkillFilter(skillFilter);
  if (normalized === undefined) {
    return undefined;
  }
  return sortUniqueStrings(normalized);
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
  if (cachedNormalized.length !== nextNormalized.length) {
    return false;
  }
  return cachedNormalized.every((entry, index) => entry === nextNormalized[index]);
}
