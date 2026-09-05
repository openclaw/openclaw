// Skill command identities bind admitted command paths to frozen workspace skill metadata.
import { canonicalizePath } from "../../agents/utils/paths.js";
import { resolveSkillTelemetrySource } from "../loading/source.js";
import type { ResolvedSkillCommand, SkillEntry } from "../types.js";
import { filterUserInvocableSkillEntries } from "./skill-index.js";

export function resolveSkillCommandIdentity(entry: SkillEntry): ResolvedSkillCommand {
  return {
    selectionPath: canonicalizePath(entry.skill.filePath),
    skillFile: entry.skill.filePath,
    skillName: entry.skill.name,
    skillSource: resolveSkillTelemetrySource(entry.skill),
  };
}

export function resolveSkillCommandIdentities(
  entries: readonly SkillEntry[],
): ResolvedSkillCommand[] {
  return filterUserInvocableSkillEntries(entries).map(resolveSkillCommandIdentity);
}
