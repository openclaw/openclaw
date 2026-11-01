export type SkillFileHost = "gateway" | "workspace";

type SkillFileHostCarrier = {
  fileHost?: SkillFileHost;
};

export function recordSkillFileHost<T extends object>(
  skill: T,
  host: SkillFileHost,
): T & SkillFileHostCarrier {
  return Object.assign(skill, { fileHost: host });
}

export function resolveSkillFileHost(skill: SkillFileHostCarrier): SkillFileHost | undefined {
  return skill.fileHost;
}

export function clearSkillFileHost<T extends SkillFileHostCarrier>(skill: T): T {
  Reflect.deleteProperty(skill, "fileHost");
  return skill;
}
