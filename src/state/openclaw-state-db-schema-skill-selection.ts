import { extractSqliteTableSchema } from "../infra/sqlite-schema-sql.js";

export const SKILL_SELECTION_COMPANION_TABLE = "audit_skill_selection_events";

export const SKILL_SELECTION_COMPANION_INDEXES = [
  "idx_audit_skill_selection_events_agent_sequence",
  "idx_audit_skill_selection_events_session_sequence",
  "idx_audit_skill_selection_events_run_sequence",
  "idx_audit_skill_selection_events_status_sequence",
  "idx_audit_skill_selection_events_occurred_sequence",
] as const;

/**
 * Exact predecessor DDL for native admission and catalog generation. The
 * skill-selection companion table postdates every released state layout, so
 * historical inputs must not inherit it: an installed reader carrying a
 * predecessor schema input would otherwise resolve replacement assets to no
 * catalog and fail admission during a build swap.
 */
export function withLegacySkillSelectionCompanionAbsent(schema: string): string {
  let result = schema;
  if (result.includes(`CREATE TABLE IF NOT EXISTS ${SKILL_SELECTION_COMPANION_TABLE} (`)) {
    const tableBlock = extractSqliteTableSchema(result, SKILL_SELECTION_COMPANION_TABLE, {
      errorMessage: "skill selection companion state schema block is missing",
    });
    // Swallow one adjacent blank line so historical inputs stay byte-identical.
    const withBlankLines = `\n${tableBlock}\n`;
    result = result.includes(withBlankLines)
      ? result.replace(withBlankLines, "")
      : result.replace(tableBlock, "");
  }
  for (const indexName of SKILL_SELECTION_COMPANION_INDEXES) {
    if (!result.includes(`CREATE INDEX IF NOT EXISTS ${indexName}`)) {
      continue;
    }
    const start = result.indexOf(`CREATE INDEX IF NOT EXISTS ${indexName}`);
    const end = result.indexOf(";", start);
    if (start < 0 || end < 0) {
      throw new Error(`skill selection companion state schema index is missing for ${indexName}`);
    }
    const precededByBlankLine = start >= 2 && result.slice(start - 2, start) === "\n\n";
    const followedByBlankLine = result[end + 1] === "\n" && result[end + 2] === "\n";
    const endLine = precededByBlankLine && followedByBlankLine ? end + 3 : end + 1;
    result = `${result.slice(0, start)}${result.slice(endLine)}`;
  }
  return result;
}
