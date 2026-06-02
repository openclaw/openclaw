import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  isPlatformMismatchOnly,
  type SkillStatusEntry,
  type SkillStatusReport,
} from "../skills/discovery/status.js";

/**
 * Collect skills that are unavailable for the agent (ineligible, not
 * disabled/blocked).  Platform-mismatch-only skills are excluded because
 * they are not broken installs — they were never designed for this OS.
 */
export function collectUnavailableAgentSkills(report: SkillStatusReport): SkillStatusEntry[] {
  return report.skills.filter(
    (skill) =>
      !skill.eligible &&
      !skill.disabled &&
      !skill.blockedByAllowlist &&
      !skill.blockedByAgentFilter &&
      !isPlatformMismatchOnly(skill),
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
