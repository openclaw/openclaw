import { sql } from "kysely";

// Plain current IDs with no optional references need only the raw ID column.
// Keep exceptional TEXT/JSON on the existing parser: SQLite and JS disagree on
// duplicate keys, escaped surrogates, literal NUL, and UTF-16 conversion.
export const sessionReferenceProjection =
  /* kysely-allow-raw: SQLite JSON primitives extract only transcript references; raw rows retain parser semantics. */ sql<
    string | null
  >`CASE WHEN json_valid(entry_json) THEN CASE
    WHEN current_session_id NOT GLOB '*[^A-Za-z0-9._:@-]*'
      AND length(CAST(current_session_id AS BLOB)) = length(CAST(printf('%s', current_session_id) AS BLOB))
      AND json_type(entry_json, '$.previousSessionId') IS NULL
      AND json_type(entry_json, '$.usageFamilySessionIds') IS NULL
      AND json_type(entry_json, '$.compactionCheckpoints') IS NULL
      THEN '{}'
    WHEN (SELECT encoding FROM pragma_encoding) = 'UTF-8'
      AND length(CAST(entry_json AS BLOB)) = length(CAST(printf('%s', entry_json) AS BLOB))
      AND instr(entry_json, '\\u') = 0
      AND json_type(entry_json, '$.sessionId') = 'text'
      AND json_extract(entry_json, '$.sessionId') = current_session_id
      AND json_type(entry_json, '$.updatedAt') IN ('integer', 'real')
      AND json_extract(entry_json, '$.updatedAt') BETWEEN -1.7976931348623157e308 AND 1.7976931348623157e308
      AND NOT EXISTS (
        SELECT 1 FROM json_each(entry_json)
        WHERE key IN ('sessionId', 'updatedAt', 'previousSessionId', 'usageFamilySessionIds', 'compactionCheckpoints')
        GROUP BY key HAVING count(*) > 1
      )
    THEN json_object(
      'sessionId', json_extract(entry_json, '$.sessionId'),
      'previousSessionId', json_extract(entry_json, '$.previousSessionId'),
      'usageFamilySessionIds', json_extract(entry_json, '$.usageFamilySessionIds'),
      'compactionCheckpoints', json_extract(entry_json, '$.compactionCheckpoints')
    ) END END`.as("reference_json");

// Validate the reference shapes before flattening them. Bad optional values must
// still fail through the original collector instead of silently permitting deletion.
export const usableSessionReferenceProjection =
  /* kysely-allow-raw: validate only the small reference projection before SQLite table-valued traversal. */ sql<
    string | null
  >`CASE WHEN reference_json = '{}' THEN reference_json
    WHEN reference_json IS NOT NULL
    AND json_type(reference_json, '$.previousSessionId') IN ('text', 'null')
    AND json_type(reference_json, '$.usageFamilySessionIds') IN ('array', 'null')
    AND json_type(reference_json, '$.compactionCheckpoints') IN ('array', 'null')
    AND NOT EXISTS (
      SELECT 1 FROM json_each(reference_json, '$.usageFamilySessionIds')
      WHERE type NOT IN ('text', 'null')
    )
    AND NOT EXISTS (
      SELECT 1 FROM json_each(reference_json, '$.compactionCheckpoints')
      WHERE json_type(reference_json, '$.compactionCheckpoints') = 'array'
        AND CASE WHEN type = 'object' THEN
        json_type(value, '$.preCompaction') IS NOT 'object'
        OR json_type(value, '$.postCompaction') IS NOT 'object'
        OR coalesce(json_type(value, '$.sessionId'), 'null') NOT IN ('text', 'null')
        OR coalesce(json_type(value, '$.preCompaction.sessionId'), 'null') NOT IN ('text', 'null')
        OR coalesce(json_type(value, '$.postCompaction.sessionId'), 'null') NOT IN ('text', 'null')
        ELSE 1 END
    )
    AND NOT EXISTS (
      SELECT 1 FROM json_tree(reference_json)
      WHERE key IS NOT NULL GROUP BY parent, key HAVING count(*) > 1
    )
    THEN reference_json END`.as("references");

export const sessionReferenceAtoms =
  /* kysely-allow-raw: emit only known reference paths, excluding checkpoint metadata and nested unrelated fields. */ sql<{
    atom: string | null;
    fullkey: string;
    type: string;
  }>`json_tree("references")`.as("reference");

export const sessionReferenceAtomPath = /* kysely-allow-raw: json_tree paths express the existing reference collector without decoding entry objects in JS. */ sql<boolean>`reference.type = 'text' AND (
    reference.fullkey IN ('$.sessionId', '$.previousSessionId')
    OR reference.fullkey GLOB '$.usageFamilySessionIds[[]*[]]'
    OR reference.fullkey GLOB '$.compactionCheckpoints[[]*[]].sessionId'
    OR reference.fullkey GLOB '$.compactionCheckpoints[[]*[]].preCompaction.sessionId'
    OR reference.fullkey GLOB '$.compactionCheckpoints[[]*[]].postCompaction.sessionId'
  )`;
