import { loadSkillLibrarySelection } from "../library/selection.js";
import type { SkillSnapshot } from "../types.js";

/** Resource access includes eligible immutable pins, not just the prompt projection. */
export function resolveSkillResourceCandidates(snapshot: SkillSnapshot | undefined) {
  if (!snapshot) {
    return undefined;
  }
  const candidates = [...(snapshot.resolvedSkills ?? [])];
  for (const entry of loadSkillLibrarySelection(snapshot.librarySelections ?? [])) {
    if (
      snapshot.skills.some((skill) => skill.name === entry.skill.name) &&
      !candidates.some((skill) => skill.name === entry.skill.name)
    ) {
      candidates.push(entry.skill);
    }
  }
  return candidates;
}
