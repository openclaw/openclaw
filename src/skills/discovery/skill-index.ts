// Shared skill name normalization and prompt/command exposure predicates.
import type { SkillEntry } from "../types.js";

/** Normalizes a skill name to the comparable key used by filters and commands. */
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
  if (entry.invocation) {
    return !entry.invocation.disableModelInvocation;
  }
  return !entry.skill.disableModelInvocation;
}

export function isSkillUserInvocable(entry: SkillEntry): boolean {
  if (entry.exposure) {
    return entry.exposure.userInvocable ?? true;
  }
  if (entry.invocation) {
    return entry.invocation.userInvocable ?? true;
  }
  return true;
}

export function filterPromptVisibleSkillEntries(entries: readonly SkillEntry[]): SkillEntry[] {
  return entries.filter(isSkillPromptVisible);
}

export function filterUserInvocableSkillEntries(entries: readonly SkillEntry[]): SkillEntry[] {
  return entries.filter(isSkillUserInvocable);
}
