import type { SkillEntry } from "../types.js";
import type { SkillStatusEntry } from "./status.types.js";

export function normalizeSkillIndexName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_/]+/g, "-")
    .replace(/[^a-z0-9-]+/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function isSkillPromptVisible(entry: SkillEntry): boolean {
  if (entry.exposure) {
    return entry.exposure.includeInAvailableSkillsPrompt ?? true;
  }
  return !(entry.invocation ?? entry.skill).disableModelInvocation;
}

export function isSkillUserInvocable(entry: SkillEntry): boolean {
  return (entry.exposure ?? entry.invocation)?.userInvocable ?? true;
}

/** Missing prerequisites exclude intentional disablement and are independent of agent exposure. */
export function hasMissingSkillRequirements(
  skill: Pick<SkillStatusEntry, "eligible" | "disabled" | "blockedByAllowlist">,
): boolean {
  return !skill.eligible && !skill.disabled && !skill.blockedByAllowlist;
}

export function resolveSkillStatusEntry<T extends Pick<SkillStatusEntry, "name" | "skillKey">>(
  skills: readonly T[],
  requestedName: string,
): T | null {
  const raw = requestedName.trim();
  if (!raw) {
    return null;
  }

  const lower = raw.toLowerCase();
  const normalized = normalizeSkillIndexName(raw);
  // Names outrank metadata aliases. A tie at the strongest matching level
  // must not redirect inspection or Workshop updates to the first loaded skill.
  const matchers: Array<(skill: T) => boolean> = [
    (skill) => skill.name === raw,
    (skill) => skill.skillKey === raw,
    (skill) => skill.name.toLowerCase() === lower || skill.skillKey.toLowerCase() === lower,
    (skill) =>
      Boolean(normalized) &&
      (normalizeSkillIndexName(skill.name) === normalized ||
        normalizeSkillIndexName(skill.skillKey) === normalized),
  ];
  for (const matches of matchers) {
    const candidates = skills.filter(matches);
    if (candidates.length > 0) {
      return candidates.length === 1 ? candidates[0]! : null;
    }
  }
  return null;
}
