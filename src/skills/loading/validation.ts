import type { OpenClawConfig } from "../../config/types.openclaw.js";

const MAX_SKILL_NAME_LENGTH = 64;
const MAX_SKILL_DESCRIPTION_LENGTH = 1024;
export const DEFAULT_MAX_SKILL_FILE_BYTES = 256_000;

export function resolveMaxSkillFileBytes(config?: OpenClawConfig): number {
  return config?.skills?.limits?.maxSkillFileBytes ?? DEFAULT_MAX_SKILL_FILE_BYTES;
}

export function assertSkillContentSize(content: string, maxBytes: number): void {
  const sizeBytes = Buffer.byteLength(content, "utf8");
  if (sizeBytes > maxBytes) {
    throw new Error(`Skill content is too large (${sizeBytes} bytes; maximum is ${maxBytes}).`);
  }
}

/** Validate a skill name against the Agent Skills contract. */
export function validateSkillName(name: string): string[] {
  const errors: string[] = [];
  if (name.length > MAX_SKILL_NAME_LENGTH) {
    errors.push(`name exceeds ${MAX_SKILL_NAME_LENGTH} characters (${name.length})`);
  }
  if (!/^[a-z0-9-]+$/.test(name)) {
    errors.push("name contains invalid characters (must be lowercase a-z, 0-9, hyphens only)");
  }
  if (name.startsWith("-") || name.endsWith("-")) {
    errors.push("name must not start or end with a hyphen");
  }
  if (name.includes("--")) {
    errors.push("name must not contain consecutive hyphens");
  }
  return errors;
}

/** Validate a skill description against the Agent Skills contract. */
export function validateSkillDescription(description: string | undefined): string[] {
  if (!description || description.trim() === "") {
    return ["description is required"];
  }
  if (description.length > MAX_SKILL_DESCRIPTION_LENGTH) {
    return [
      `description exceeds ${MAX_SKILL_DESCRIPTION_LENGTH} characters (${description.length})`,
    ];
  }
  return [];
}
