/**
 * Skill-related config types for discovery, installation, limits, and per-skill overrides.
 * Secret-bearing skill options use SecretInput so config redaction and secret refs stay consistent.
 */
import type { z } from "zod";
import type { SkillsConfigSchema } from "./zod-schema.skills.js";

type SkillsInput = z.input<typeof SkillsConfigSchema>;
export type SkillsConfig = SkillsInput;
export type SkillConfig = NonNullable<NonNullable<SkillsInput["entries"]>[string]>;
export type SkillsLoadConfig = NonNullable<SkillsInput["load"]>;
export type SkillsInstallConfig = NonNullable<SkillsInput["install"]>;
export type SkillsLimitsConfig = NonNullable<SkillsInput["limits"]>;
export type SkillsWorkshopConfig = NonNullable<SkillsInput["workshop"]>;
export type SkillsWorkshopAutonomousMode = NonNullable<
  NonNullable<SkillsWorkshopConfig["autonomous"]>["mode"]
>;
