import type { SkillStatusEntry } from "../api/types.ts";
import { t } from "../i18n/index.ts";

export function computeSkillMissing(skill: SkillStatusEntry): string[] {
  return [
    ...skill.missing.bins.map((b) => `bin:${b}`),
    ...(skill.missing.anyBins.length > 0
      ? [`bin:any of (${skill.missing.anyBins.join(", ")})`]
      : []),
    ...skill.missing.env.map((e) => `env:${e}`),
    ...skill.missing.config.map((c) => `config:${c}`),
    ...skill.missing.os.map((o) => `os:${o}`),
  ];
}

export function computeSkillReasons(skill: SkillStatusEntry): string[] {
  const reasons = [
    [skill.disabled, "skillStatus.disabled"],
    [skill.blockedByAllowlist, "skillStatus.blockedAllowlist"],
    [skill.blockedByAgentFilter, "skillStatus.blockedAgentFilter"],
  ] as const;
  return reasons.flatMap(([blocked, key]) => (blocked ? [t(key)] : []));
}

export function isSkillAvailable(skill: SkillStatusEntry): boolean {
  return skill.eligible && !skill.blockedByAgentFilter;
}

/** Learned Workshop skills bypass agent allowlists; archiving in the Workshop hides one. */
export function isWorkshopSkill(skill: Pick<SkillStatusEntry, "source">): boolean {
  return skill.source === "openclaw-workshop";
}
