// Collects full Doctor diagnostics after runtime config validation fails.
import { LEGACY_CONFIG_MIGRATION_RULES as LEGACY_CONFIG_RULES } from "../commands/doctor/shared/legacy-config-migrations.js";
import { findLegacyConfigRuleIssues, type LegacyConfigRule } from "./legacy.shared.js";
import type { LegacyConfigIssue } from "./types.js";

/** Finds legacy config issues using built-in rules plus optional caller rules. */
export function findLegacyConfigIssues(
  raw: unknown,
  sourceRaw?: unknown,
  extraRules: LegacyConfigRule[] = [],
): LegacyConfigIssue[] {
  return findLegacyConfigRuleIssues(raw, [...LEGACY_CONFIG_RULES, ...extraRules], sourceRaw);
}
