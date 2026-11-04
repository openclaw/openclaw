import {
  postgresSearchTextTriggerSql,
  postgresSearchVectorSql,
} from "../infra/database-engine/postgres-search-schema.js";

// PL/pgSQL format() renders the pre-quoted identifiers; literal percent signs and quotes
// are escaped so the trigger body stays byte-identical to the fresh DDL's body.
const template = (sql: string) =>
  sql
    .replaceAll("%", "%%")
    .replaceAll("__TABLE__", "%1$s")
    .replaceAll("__FIELD__", "%2$s")
    .replaceAll("__SYNC__", "%3$s")
    .replaceAll("__CONFIG__", "%4$L")
    .replaceAll("'", "''");
const trigger = template(
  postgresSearchTextTriggerSql({ table: "__TABLE__", field: "__FIELD__", sync: "__SYNC__" }),
);
const backfill = template(
  `UPDATE __TABLE__ SET openclaw_search = ${postgresSearchVectorSql("__CONFIG__", "__FIELD__", 2)}`,
);

// The predecessor seal validates these owner-persisted definitions before this migration runs.
// Each admitted text index keeps its column position: the generated expression is dropped in
// place, the version 2 trigger takes over, and every existing row is reparsed once.
export const AGENT_TEXT_SEARCH_POSTGRES_SQL = `DO $migration$
DECLARE text_index jsonb; tbl text; fld text; sync text;
  config text := format('%I.%I', current_schema(), 'openclaw_simple_unaccent');
BEGIN
  FOR text_index IN
    SELECT jsonb_build_object('table', 'session_transcript_fts', 'fields', jsonb_build_array('text'))
    UNION ALL
    SELECT indexes.value FROM openclaw_schema_meta meta,
      jsonb_each(coalesce((to_jsonb(meta)->>'search_extensions')::jsonb, '{}'::jsonb)) extensions,
      jsonb_each(coalesce(extensions.value->'text', '{}'::jsonb)) indexes
    WHERE meta.store = 'agent'
  LOOP
    IF to_regclass(format('%I', text_index->>'table')) IS NULL THEN CONTINUE; END IF;
    tbl := '"' || replace(text_index->>'table', '"', '""') || '"';
    fld := '"' || replace(text_index->'fields'->>0, '"', '""') || '"';
    sync := '"' || replace((text_index->>'table') || '_search_sync', '"', '""') || '"';
    EXECUTE format('ALTER TABLE %s ALTER COLUMN openclaw_search DROP EXPRESSION', tbl);
    EXECUTE format('${trigger}', tbl, fld, sync);
    EXECUTE format('${backfill}', tbl, fld, sync, config);
  END LOOP;
END $migration$;`;
