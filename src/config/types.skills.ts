/**
 * Skill-related config types for discovery, installation, limits, and per-skill overrides.
 * Secret-bearing skill options use SecretInput so config redaction and secret refs stay consistent.
 */

import type { z } from "zod";
import type { SecretInput } from "./types.secrets.js";
import type { OpenClawSchemaShape } from "./zod-schema.root-shape.js";

type SkillsSchemaInput = NonNullable<z.input<typeof OpenClawSchemaShape.skills>>;

/** Per-skill runtime override keyed by skill name or source-specific skill key. */
export type SkillConfig = Omit<NonNullable<SkillsSchemaInput["entries"]>[string], "apiKey"> & {
  /** Optional secret made available to the skill runtime through skill env handling. */
  apiKey?: SecretInput;
};

/** Autonomous and approval settings for generated skill proposals. */
export type SkillsWorkshopConfig = NonNullable<SkillsSchemaInput["workshop"]>;

export type SkillsWorkshopAutonomousMode = NonNullable<
  NonNullable<SkillsWorkshopConfig["autonomous"]>["mode"]
>;

/** Top-level skills config block in openclaw config. */
export type SkillsConfig = Omit<SkillsSchemaInput, "entries"> & {
  entries?: Record<string, SkillConfig>;
};
