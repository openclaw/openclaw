import { applyIdentityDefaults, applySessionDefaults } from "./defaults.js";
import { findLegacyConfigIssues } from "./legacy.js";
import type { ClawdisConfig, ConfigValidationIssue } from "./types.js";
import { ClawdisSchema } from "./zod-schema.js";

export function validateConfigObject(
  raw: unknown,
):
  | { ok: true; config: ClawdisConfig }
  | { ok: false; issues: ConfigValidationIssue[] } {
  const legacyIssues = findLegacyConfigIssues(raw);
  if (legacyIssues.length > 0) {
    return {
      ok: false,
      issues: legacyIssues.map((iss) => ({
        path: iss.path,
        message: iss.message,
      })),
    };
  }
  const validated = ClawdisSchema.safeParse(raw);
  if (!validated.success) {
    return {
      ok: false,
      issues: validated.error.issues.map((iss) => ({
        path: iss.path.join("."),
        message: iss.message,
      })),
    };
  }
  return {
    ok: true,
    config: applySessionDefaults(
      applyIdentityDefaults(validated.data as ClawdisConfig),
    ),
  };
}
