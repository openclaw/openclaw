import type { Skill } from "@mariozechner/pi-coding-agent";
import type { TaskProfileId } from "./task-profile.js";

const TASK_PROFILE_SKILL_DENY_PATTERNS: Partial<Record<TaskProfileId, RegExp[]>> = {
  coding: [/\bweather\b/i],
  research: [
    /\bhealthcheck\b/i,
    /\bnode[-_ ]?connect\b/i,
    /\bskill[-_ ]?creator\b/i,
    /\bdeploy|gateway|cron|ops\b/i,
  ],
  ops: [/\bweather\b/i, /\bskill[-_ ]?creator\b/i],
  assistant: [
    /\bhealthcheck\b/i,
    /\bnode[-_ ]?connect\b/i,
    /\bskill[-_ ]?creator\b/i,
    /\bdeploy|gateway|cron|ops\b/i,
  ],
};

function buildSkillSearchText(skill: Skill): string {
  return [skill.name, skill.description, skill.filePath, skill.baseDir]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(" ");
}

export function filterSkillsForTaskProfile(params: {
  skills: Skill[];
  taskProfile?: TaskProfileId;
  alwaysSkillNames?: Set<string>;
}): Skill[] {
  const patterns = params.taskProfile
    ? TASK_PROFILE_SKILL_DENY_PATTERNS[params.taskProfile]
    : undefined;
  if (!patterns || patterns.length === 0 || params.skills.length === 0) {
    return params.skills;
  }
  const alwaysSkillNames = params.alwaysSkillNames ?? new Set<string>();
  const filtered = params.skills.filter((skill) => {
    if (alwaysSkillNames.has(skill.name)) {
      return true;
    }
    const searchText = buildSkillSearchText(skill);
    return !patterns.some((pattern) => pattern.test(searchText));
  });
  return filtered.length > 0 ? filtered : params.skills;
}
