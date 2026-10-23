import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { SkillsWorkshopAutonomousMode } from "../../config/types.skills.js";

/** Runtime configuration for Skill Workshop. */
type SkillWorkshopConfig = {
  autonomous: {
    mode: SkillsWorkshopAutonomousMode;
    channelNotices: boolean;
  };
  maxSkillBytes: number;
};

export function resolveSkillWorkshopConfig(config?: OpenClawConfig): SkillWorkshopConfig {
  const raw = config?.skills?.workshop;
  return {
    autonomous: {
      mode: raw?.autonomous?.mode ?? "auto",
      channelNotices: raw?.autonomous?.channelNotices ?? false,
    },
    maxSkillBytes: Math.min(Math.max(raw?.maxSkillBytes ?? 40_000, 1024), 200_000),
  };
}
