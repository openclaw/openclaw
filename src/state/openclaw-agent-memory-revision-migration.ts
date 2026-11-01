const revisionTables = ["memory_index_sources", "memory_index_chunks"] as const;
const revisionEvents = ["insert", "update", "delete"] as const;
export const LEGACY_MEMORY_REVISION_SQLITE_TRIGGERS = revisionTables.flatMap((table) =>
  revisionEvents.map((event) => ({
    name: `${table}_revision_after_${event}`,
    table,
    sql: `CREATE TRIGGER IF NOT EXISTS ${table}_revision_after_${event}
AFTER ${event.toUpperCase()} ON ${table}
BEGIN
  UPDATE memory_index_state SET revision = revision + 1 WHERE id = 1;
END;`,
  })),
);
export const LEGACY_MEMORY_REVISION_TRIGGER_NAMES = LEGACY_MEMORY_REVISION_SQLITE_TRIGGERS.map(
  (trigger) => trigger.name,
);

/** Historical admission and rollback retain the row triggers written before schema 31. */
export function withLegacyAgentMemoryRevisionTriggers(schema: string): string {
  const triggers = LEGACY_MEMORY_REVISION_SQLITE_TRIGGERS.map((trigger) => trigger.sql).join(
    "\n\n",
  );
  return schema.replace(
    "CREATE INDEX IF NOT EXISTS idx_memory_embedding_cache_updated_at",
    `${triggers}\n\nCREATE INDEX IF NOT EXISTS idx_memory_embedding_cache_updated_at`,
  );
}

export function withLegacyAgentPostgresMemoryRevisionTriggers(schema: string): string {
  return `${schema}\n${revisionTables
    .map(
      (
        table,
      ) => `CREATE FUNCTION "openclaw_${table}_trigger"() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $trigger$
BEGIN
  UPDATE memory_index_state SET revision = revision + 1 WHERE id = 1;
  RETURN NULL;
END;
$trigger$;
${revisionEvents
  .map(
    (event) =>
      `CREATE TRIGGER "${table}_revision_after_${event}" AFTER ${event.toUpperCase()} ON "${table}" FOR EACH ROW EXECUTE FUNCTION "openclaw_${table}_trigger"();`,
  )
  .join("\n")}`,
    )
    .join("\n\n")}`;
}

export const AGENT_MEMORY_REVISION_SQL = revisionTables
  .flatMap((table) =>
    revisionEvents.map((event) => `DROP TRIGGER IF EXISTS ${table}_revision_after_${event};`),
  )
  .join("\n");

export const AGENT_MEMORY_REVISION_POSTGRES_SQL = revisionTables
  .map(
    (table) => `${revisionEvents
      .map((event) => `DROP TRIGGER IF EXISTS ${table}_revision_after_${event} ON ${table};`)
      .join("\n")}
DROP FUNCTION IF EXISTS openclaw_${table}_trigger();`,
  )
  .join("\n");
