import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { SkillsWorkshopAutonomousMode } from "../../config/types.skills.js";

/** Runtime configuration for Skill Workshop. */
type SkillWorkshopConfig = {
  autonomous: {
    mode: SkillsWorkshopAutonomousMode;
  };
  maxSkillBytes: number;
};

export function resolveSkillWorkshopConfig(config?: OpenClawConfig): SkillWorkshopConfig {
  const raw = asNullableRecord(config?.skills?.workshop) ?? {};
  const mode = asNullableRecord(raw.autonomous)?.mode;
  const maxSkillBytes = raw.maxSkillBytes;
  return {
    autonomous: { mode: mode === "off" || mode === "auto" ? mode : "auto" },
    maxSkillBytes:
      typeof maxSkillBytes === "number" && Number.isFinite(maxSkillBytes)
        ? Math.min(Math.max(Math.trunc(maxSkillBytes), 1024), 200_000)
        : 40_000,
  };
}
