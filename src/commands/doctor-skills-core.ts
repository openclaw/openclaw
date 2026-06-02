import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SkillStatusEntry, SkillStatusReport } from "../skills/discovery/status.js";

export function collectUnavailableAgentSkills(report: SkillStatusReport): SkillStatusEntry[] {
  return report.skills.filter(
    (skill) =>
      !skill.eligible &&
      !skill.disabled &&
      !skill.blockedByAllowlist &&
      !skill.blockedByAgentFilter &&
      // Platform-incompatible skills (declared OS requirement excludes this host)
      // are not broken installs to disable — they remain applicable on a matching
      // OS, so doctor --fix should leave them alone.
      !skill.platformIncompatible,
  );
}

export function disableUnavailableSkillsInConfig(
  config: OpenClawConfig,
  skills: readonly SkillStatusEntry[],
): OpenClawConfig {
  if (skills.length === 0) {
    return config;
  }
  const entries = { ...config.skills?.entries };
  for (const skill of skills) {
    entries[skill.skillKey] = {
      ...entries[skill.skillKey],
      enabled: false,
    };
  }
  return {
    ...config,
    skills: {
      ...config.skills,
      entries,
    },
  };
}
