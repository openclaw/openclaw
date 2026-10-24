// Applies legacy config rules during load-time compatibility checks.
import { LEGACY_CONFIG_MIGRATION_RULES as LEGACY_CONFIG_RULES } from "../commands/doctor/shared/legacy-config-migrations.js";
import { readObjectPath } from "../shared/dot-path.js";
import type { LegacyConfigRule } from "./legacy.shared.js";
import type { LegacyConfigIssue } from "./types.js";

/** Finds legacy config issues using built-in rules plus optional caller rules. */
export function findLegacyConfigIssues(
  raw: unknown,
  sourceRaw?: unknown,
  extraRules: LegacyConfigRule[] = [],
): LegacyConfigIssue[] {
  return findLegacyConfigRuleIssues(raw, [...LEGACY_CONFIG_RULES, ...extraRules], sourceRaw);
}

/** Evaluate exactly the rules selected by the migration owner. */
export function findLegacyConfigRuleIssues(
  raw: unknown,
  rules: readonly LegacyConfigRule[],
  sourceRaw?: unknown,
): LegacyConfigIssue[] {
  if (!raw || typeof raw !== "object") {
    return [];
  }
  const root = raw as Record<string, unknown>;
  const sourceRoot =
    sourceRaw && typeof sourceRaw === "object" ? (sourceRaw as Record<string, unknown>) : root;
  const issues: LegacyConfigIssue[] = [];
  for (const rule of rules) {
    const cursor = readObjectPath(root, rule.path);
    if (cursor !== undefined && (!rule.match || rule.match(cursor, root))) {
      if (rule.requireSourceLiteral) {
        const sourceCursor = readObjectPath(sourceRoot, rule.path);
        if (sourceCursor === undefined) {
          continue;
        }
        if (rule.match && !rule.match(sourceCursor, sourceRoot)) {
          continue;
        }
      }
      issues.push({ path: rule.path.join("."), message: rule.message });
    }
  }
  return issues;
}
