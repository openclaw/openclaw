import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { sql, type Expression } from "kysely";
import { jsonObjectFieldsForScan } from "../../infra/database-engine/json-values.js";
import { isPostgresSqlConnection, type EngineConnection } from "../../infra/sql-connection.js";
import { scanJsonObjectFields } from "../../state/json-predicate-fields.js";

const navigationFields = {
  type: true,
  id: true,
  parentId: true,
  targetId: true,
  appendParentId: true,
  appendMode: true,
  firstKeptEntryId: true,
  customType: true,
  display: true,
} as const;

export function readTranscriptNavigation(eventJson: string): Record<string, unknown> | undefined {
  const selected = Object.keys(navigationFields);
  const fields = scanJsonObjectFields(eventJson, selected);
  if (!fields.valid || fields.maximumDepth > 1000 || !eventJson.trimStart().startsWith("{")) {
    const parsed: unknown = JSON.parse(eventJson);
    if (!isRecord(parsed)) {
      return undefined;
    }
    // Invalid and SQLite-overdepth rows retain the original JSON.parse fallback.
    return Object.fromEntries(
      selected.filter((key) => Object.hasOwn(parsed, key)).map((key) => [key, parsed[key]]),
    );
  }
  const navigation: Record<string, unknown> = {};
  for (const key of selected) {
    const token = fields.last.get(key);
    // Parentless entries are distinct from malformed explicit parents in the tree owner.
    if (token) {
      navigation[key] = JSON.parse(token.text);
    }
  }
  return navigation;
}

/** Keep tree/reset facts compact without changing exceptional raw-JSON handling. */
export function projectTranscriptNavigationForReadSql(
  database: EngineConnection,
  event: Expression<string>,
) {
  const projected = jsonObjectFieldsForScan(database, event, navigationFields);
  // SQLite can transcode escaped lone surrogates in native string aggregation.
  // Keep those bytes for the lexical reader, which retains only navigation fields.
  return isPostgresSqlConnection(database)
    ? projected
    : /* kysely-allow-raw: preserve escaped Unicode before SQLite aggregates decoded strings. */ sql<string>`CASE WHEN instr(${event}, ${String.raw`\u`}) > 0 THEN ${event} ELSE ${projected} END`;
}
