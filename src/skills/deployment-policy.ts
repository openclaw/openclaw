import path from "node:path";
import { isTruthyEnvValue } from "../infra/env.js";

export const SKILL_MUTATIONS_DISABLED_MESSAGE =
  "Skill mutations are disabled on this managed Gateway.";

/** Process-owned deployment policy cannot be changed through Gateway configuration. */
export function skillMutationsDisabled(): boolean {
  return isTruthyEnvValue(process.env.OPENCLAW_DISABLE_SKILL_INSTALLS);
}

export function assertSkillMutationsEnabled(): void {
  if (skillMutationsDisabled()) {
    throw new Error(SKILL_MUTATIONS_DISABLED_MESSAGE);
  }
}

/** Exact Gateway-hosted SKILL.md files selected by the deployment. */
export function deploymentSkillPins(): Map<string, string> {
  const raw = process.env.OPENCLAW_PINNED_SKILL_FILES;
  if (!raw) {
    return new Map();
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(
      "OPENCLAW_PINNED_SKILL_FILES must be a JSON object of skill names and absolute SKILL.md paths.",
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      "OPENCLAW_PINNED_SKILL_FILES must be a JSON object of skill names and absolute SKILL.md paths.",
    );
  }
  const pins = new Map<string, string>();
  for (const [name, file] of Object.entries(value)) {
    if (
      !name.trim() ||
      typeof file !== "string" ||
      !path.isAbsolute(file) ||
      path.basename(file) !== "SKILL.md"
    ) {
      throw new Error(
        "OPENCLAW_PINNED_SKILL_FILES must contain skill names and absolute SKILL.md paths.",
      );
    }
    pins.set(name, file);
  }
  return pins;
}
