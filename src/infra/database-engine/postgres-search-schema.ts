import type { PostgresSqlConnection } from "../sql-connection.js";
import {
  getSqliteDatabaseAdmission,
  publishSqliteDatabaseAdmission,
  type SqliteDatabaseFactKey,
} from "../sqlite-database-admission.js";
import { DatabaseSearchCapabilityUnavailableError } from "./capability-unavailable.js";
import type { SearchSchema } from "./contract.js";

export const pgSearchName = (name: string) => `"${name.replaceAll('"', '""')}"`;
export const searchConfig = "openclaw_simple_unaccent";
/**
 * PostgreSQL's parser keeps dates, paths, file names and `a/b` as single lexemes
 * (`-08`, `server.py`, `/v1/models`); SQLite FTS5 unicode61 splits on every
 * non-alphanumeric character. Replacing punctuation runs before parsing gives
 * both engines the same words; the ASCII class keeps the expression locale-stable.
 */
export const postgresSearchTokenSeparators = "[[:punct:]]+";
/** The stored vector expression; `config` and `field` are already-rendered SQL. */
export function postgresSearchVectorSql(
  config: string,
  field: string,
  textSearchVersion: 1 | 2 = 1,
): string {
  const text = `coalesce(${field}, '')`;
  const words =
    textSearchVersion === 2
      ? `regexp_replace(${text}, '${postgresSearchTokenSeparators}', ' ', 'g')`
      : text;
  return `to_tsvector(${config}::regconfig, ${words})`;
}
/**
 * Version 2 maintains the vector from a trigger instead of a generated column:
 * PostgreSQL 16 cannot change a generated expression in place, and dropping the
 * column would move its position out of the sealed catalog. The body resolves
 * the configuration from the trigger's own schema so it carries no namespace.
 */
export function postgresSearchTextTriggerSql(params: {
  table: string;
  field: string;
  sync: string;
}): string {
  const { table, field, sync } = params;
  const vector = postgresSearchVectorSql(
    `format('%I.%I', TG_TABLE_SCHEMA, '${searchConfig}')`,
    `NEW.${field}`,
    2,
  );
  return `CREATE FUNCTION ${sync}() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.openclaw_search := ${vector};
  RETURN NEW;
END $$;
CREATE TRIGGER ${sync} BEFORE INSERT OR UPDATE OF ${field} ON ${table} FOR EACH ROW EXECUTE FUNCTION ${sync}();`;
}
const key: SqliteDatabaseFactKey<{ signature: string; vectorSearchVersion: 1 | 2 }[]> = {
  name: "database.postgres.search",
  schemaDependent: true,
};

/** Called only by store admission; query paths consume these retained facts. */
export function admitPostgresSearch(
  db: PostgresSqlConnection,
  schema: SearchSchema,
  namespace: string,
  vectorSearchVersion: 1 | 2 = 1,
): (() => void) | undefined {
  const signature = JSON.stringify(schema);
  const retained = getSqliteDatabaseAdmission(db, key);
  if (
    retained?.some(
      (fact) => fact.signature === signature && fact.vectorSearchVersion >= vectorSearchVersion,
    )
  ) {
    return undefined;
  }
  const required = new Set<string>();
  if (Object.keys(schema.text ?? {}).length) {
    required.add("unaccent");
  }
  if (Object.values(schema.text ?? {}).some((index) => index.postgres?.mode === "trigram")) {
    required.add("pg_trgm");
  }
  if (schema.mode !== "keyword-only" && Object.keys(schema.vector ?? {}).length) {
    required.add("vector");
  }
  for (const index of schema.mode === "keyword-only" ? [] : Object.values(schema.vector ?? {})) {
    const dimensions = index.postgres?.dimensions;
    if (!Number.isInteger(dimensions) || dimensions! < 1 || dimensions! > 16_000) {
      throw new Error(
        "PostgreSQL vector capability unavailable: dimensions must be 1–16000; choose a supported embedding dimension and rebuild the derived index.",
      );
    }
  }
  const extensionSchema = schema.extensionSchema ?? "public";
  const rows = db
    .prepare(`SELECT a.name, e.extname, e.extversion, n.nspname FROM pg_catalog.pg_available_extensions a
    LEFT JOIN pg_catalog.pg_extension e ON e.extname = a.name
    LEFT JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace
    WHERE a.name IN ('unaccent', 'pg_trgm', 'vector')`)
    .all();
  for (const name of required) {
    const found = rows.find((row) => row.name === name);
    if (!found?.extname || found.nspname !== extensionSchema) {
      const action = !found
        ? `Install the server extension package for ${name}, then have a database administrator run`
        : found.extname
          ? `Configure the store's extensionSchema as ${String(found.nspname)}, or have a database administrator relocate the extension; installation SQL is`
          : "Have a database administrator run";
      throw new DatabaseSearchCapabilityUnavailableError(
        name === "vector" ? "vector" : "fullText",
        `PostgreSQL ${name} capability unavailable. ${action}: CREATE EXTENSION IF NOT EXISTS ${pgSearchName(name)} WITH SCHEMA ${pgSearchName(extensionSchema)};${name === "vector" ? ' For keyword-only memory explicitly set memory.search.provider to "none".' : ""}`,
      );
    }
    if (name === "vector" && vectorSearchVersion === 2) {
      const version = /^(\d+)\.(\d+)/.exec(String(found.extversion));
      if (!version || (Number(version[1]) === 0 && Number(version[2]) < 7)) {
        throw new DatabaseSearchCapabilityUnavailableError(
          "vector",
          "PostgreSQL binary vector search requires pgvector 0.7 or newer. Upgrade the server extension package, then have a database administrator run ALTER EXTENSION vector UPDATE before reopening the store.",
        );
      }
    }
  }
  const privilege = db
    .prepare(
      "SELECT coalesce(has_schema_privilege(to_regnamespace(?), 'CREATE'), has_database_privilege(current_database(), 'CREATE'))::int AS allowed",
    )
    .get(namespace);
  if (privilege?.allowed !== 1) {
    throw new Error(
      `PostgreSQL search capability unavailable: insufficient CREATE privilege. Have the database owner grant CREATE on schema ${pgSearchName(namespace)} (or on the database before initial admission).`,
    );
  }
  return () => publishPostgresSearch(db, schema, vectorSearchVersion);
}

export function publishPostgresSearch(
  db: PostgresSqlConnection,
  schema: SearchSchema,
  vectorSearchVersion: 1 | 2 = 1,
): void {
  const signature = JSON.stringify(schema);
  const retained = getSqliteDatabaseAdmission(db, key) ?? [];
  const previous = retained.find((fact) => fact.signature === signature);
  publishSqliteDatabaseAdmission(db, key, [
    ...retained.filter((fact) => fact.signature !== signature),
    {
      signature,
      vectorSearchVersion: previous?.vectorSearchVersion === 2 ? 2 : vectorSearchVersion,
    },
  ]);
}

export function assertPostgresSearchAdmitted(
  db: PostgresSqlConnection,
  schema: SearchSchema,
): void {
  if (
    !db.isOpen ||
    !getSqliteDatabaseAdmission(db, key)?.some((fact) => fact.signature === JSON.stringify(schema))
  ) {
    throw new DatabaseSearchCapabilityUnavailableError(
      schema.mode !== "keyword-only" && Object.keys(schema.vector ?? {}).length
        ? "vector"
        : "fullText",
      "PostgreSQL search requires matching store admission; reopen the store with its search schema.",
    );
  }
}

/** Canonical bytes remain binary64; the derived vector rounds once to float32. */
export function postgresVectorDecoderSql(
  extensionSchema: string,
  version: 1 | 2 = 1,
  replace = false,
): string {
  const ext = pgSearchName(extensionSchema);
  if (version === 1) {
    return `CREATE ${replace ? "OR REPLACE " : ""}FUNCTION openclaw_vector(bytes bytea, dimensions integer) RETURNS ${ext}.vector
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE vals real[] := '{}'; bits bigint; exponent integer; fraction double precision; value double precision;
BEGIN
  IF octet_length(bytes) <> dimensions * 8 THEN RAISE EXCEPTION 'embedding dimension mismatch; rebuild the derived vector index'; END IF;
  FOR i IN 0..dimensions-1 LOOP
    bits := 0;
    FOR j IN 0..7 LOOP bits := bits | (get_byte(bytes, i*8+j)::bigint << (j*8)); END LOOP;
    exponent := ((bits >> 52) & 2047)::integer;
    IF exponent = 2047 THEN RAISE EXCEPTION 'embedding must be finite'; END IF;
    fraction := (bits & 4503599627370495)::double precision / 4503599627370496;
    IF exponent < 873 OR (exponent = 873 AND fraction = 0) THEN value := 0;
    ELSE value := (1 + fraction) * power(2::double precision, exponent - 1023); END IF;
    IF bits < 0 THEN value := -value; END IF;
    vals := array_append(vals, value::real);
  END LOOP;
  RETURN vals::${ext}.vector;
END $$;`;
  }
  return `CREATE ${replace ? "OR REPLACE " : ""}FUNCTION openclaw_vector(bytes bytea, dimensions integer) RETURNS ${ext}.vector
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE vals double precision[]; first_nonfinite integer;
BEGIN
  IF octet_length(bytes) <> dimensions * 8 THEN RAISE EXCEPTION 'embedding dimension mismatch; rebuild the derived vector index'; END IF;
  -- Flatten TOAST once: repeated get_byte calls otherwise detoast the entire embedding.
  bytes := bytes || '\\x'::bytea;
  WITH bits AS MATERIALIZED (
    SELECT i,
      get_byte(bytes, i*8)::bigint |
      (get_byte(bytes, i*8+1)::bigint << 8) |
      (get_byte(bytes, i*8+2)::bigint << 16) |
      (get_byte(bytes, i*8+3)::bigint << 24) |
      (get_byte(bytes, i*8+4)::bigint << 32) |
      (get_byte(bytes, i*8+5)::bigint << 40) |
      (get_byte(bytes, i*8+6)::bigint << 48) |
      (get_byte(bytes, i*8+7)::bigint << 56) AS b
    FROM generate_series(0, dimensions-1) AS i
  ), parts AS (
    SELECT i, b, ((b >> 52) & 2047)::integer AS exponent,
      (b & 4503599627370495)::double precision / 4503599627370496 AS fraction
    FROM bits
  )
  SELECT coalesce(array_agg(
    CASE WHEN b < 0 THEN -1::double precision ELSE 1::double precision END *
    CASE WHEN exponent = 2047 OR exponent < 873 OR (exponent = 873 AND fraction = 0)
      THEN 0::double precision
      ELSE (1 + fraction) * power(2::double precision, exponent - 1023)
    END ORDER BY i
  ), ARRAY[]::double precision[]), min(i) FILTER (WHERE exponent = 2047)
  INTO vals, first_nonfinite FROM parts;
  IF first_nonfinite IS NOT NULL THEN
    -- Preserve the old left-to-right overflow versus nonfinite error precedence.
    PERFORM vals[1:first_nonfinite]::real[];
    RAISE EXCEPTION 'embedding must be finite';
  END IF;
  RETURN vals::real[]::${ext}.vector;
END $$;`;
}

/** Deterministic derived DDL joins the store's generated DDL hash and exact catalog seal. */
export function postgresSearchSql(
  schema: SearchSchema,
  namespace: string,
  shared: { text?: boolean; vector?: boolean } = {},
  decoderVersion: 1 | 2 = 1,
  vectorSearchVersion: 1 | 2 = 1,
  textSearchVersion: 1 | 2 = 1,
): string {
  const ext = pgSearchName(schema.extensionSchema ?? "public");
  const config = `${pgSearchName(namespace)}.${pgSearchName(searchConfig)}`;
  const configLiteral = `'${config.replaceAll("'", "''")}'`;
  const statements: string[] = [];
  if (Object.keys(schema.text ?? {}).length && !shared.text) {
    statements.push(`CREATE TEXT SEARCH CONFIGURATION ${config} (COPY = pg_catalog.simple);
ALTER TEXT SEARCH CONFIGURATION ${config} ALTER MAPPING FOR hword, hword_part, word, numword, numhword, hword_numpart WITH ${ext}.unaccent, pg_catalog.simple;`);
  }
  for (const index of Object.values(schema.text ?? {})) {
    if (!index.postgres || index.fields.length !== 1) {
      throw new Error("PostgreSQL text index requires one field and a declared source identity");
    }
    const table = pgSearchName(index.table),
      field = pgSearchName(index.fields[0]!);
    statements.push(
      textSearchVersion === 2
        ? // The backfill is a no-op on fresh tables and indexes rows a port copied before this DDL.
          `ALTER TABLE ${table} ADD COLUMN openclaw_search tsvector;
${postgresSearchTextTriggerSql({ table, field, sync: pgSearchName(`${index.table}_search_sync`) })}
UPDATE ${table} SET openclaw_search = ${postgresSearchVectorSql(configLiteral, field, 2)};`
        : `ALTER TABLE ${table} ADD COLUMN openclaw_search tsvector GENERATED ALWAYS AS (${postgresSearchVectorSql(configLiteral, field)}) STORED;`,
    );
    statements.push(
      `CREATE INDEX ${pgSearchName(`${index.table}_search_gin`)} ON ${table} USING gin(openclaw_search);`,
    );
    if (index.postgres.mode === "trigram") {
      statements.push(
        `CREATE INDEX ${pgSearchName(`${index.table}_trgm_gin`)} ON ${table} USING gin(${field} ${ext}.gin_trgm_ops);`,
      );
    }
  }
  if (schema.mode === "keyword-only") {
    return statements.join("\n");
  }
  if (Object.keys(schema.vector ?? {}).length && !shared.vector) {
    statements.push(postgresVectorDecoderSql(schema.extensionSchema ?? "public", decoderVersion));
  }
  for (const index of Object.values(schema.vector ?? {})) {
    const source = index.postgres;
    if (!source) {
      throw new Error("PostgreSQL vector index requires a canonical embedding source");
    }
    const table = pgSearchName(index.table),
      owner = pgSearchName(source.source),
      id = pgSearchName(source.key),
      embedding = pgSearchName(source.embedding);
    // Empty canonical bytes mean a text-only row, including NOT NULL source columns.
    const project = `INSERT INTO ${table}(id, embedding) SELECT ${id}, openclaw_vector(${embedding}, ${source.dimensions}) FROM ${owner} WHERE octet_length(${embedding}) > 0`;
    const bits =
      vectorSearchVersion === 2
        ? `, embedding_bits bit(${source.dimensions}) GENERATED ALWAYS AS (CASE WHEN ${ext}.vector_norm(embedding) > 0 THEN ${ext}.binary_quantize(embedding)::bit(${source.dimensions}) ELSE NULL END) STORED`
        : "";
    statements.push(`CREATE TABLE ${table} (id TEXT PRIMARY KEY REFERENCES ${owner}(${id}) ON UPDATE CASCADE ON DELETE CASCADE, embedding ${ext}.vector(${source.dimensions}) NOT NULL${bits});
CREATE FUNCTION ${pgSearchName(`${index.table}_sync`)}() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.${embedding} IS NOT DISTINCT FROM NEW.${embedding} THEN RETURN NEW; END IF;
  IF octet_length(NEW.${embedding}) > 0 THEN
    INSERT INTO ${table}(id, embedding) VALUES (NEW.${id}, openclaw_vector(NEW.${embedding}, ${source.dimensions}))
    ON CONFLICT (id) DO UPDATE SET embedding = EXCLUDED.embedding;
  ELSE
    DELETE FROM ${table} WHERE id = NEW.${id};
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ${pgSearchName(`${index.table}_sync`)} AFTER INSERT OR UPDATE OF ${embedding} ON ${owner} FOR EACH ROW EXECUTE FUNCTION ${pgSearchName(`${index.table}_sync`)}();
${project};`);
  }
  return statements.join("\n");
}

export function rebuildPostgresSearch(db: PostgresSqlConnection, schema: SearchSchema): void {
  assertPostgresSearchAdmitted(db, schema);
  if (!db.isTransaction) {
    throw new Error("Search rebuild requires the owner's transaction");
  }
  for (const index of Object.values(schema.text ?? {})) {
    db.exec(`REINDEX INDEX ${pgSearchName(`${index.table}_search_gin`)}`);
    if (index.postgres?.mode === "trigram") {
      db.exec(`REINDEX INDEX ${pgSearchName(`${index.table}_trgm_gin`)}`);
    }
  }
  if (schema.mode === "keyword-only") {
    return;
  }
  for (const index of Object.values(schema.vector ?? {})) {
    const source = index.postgres!;
    db.exec(
      `DELETE FROM ${pgSearchName(index.table)}; INSERT INTO ${pgSearchName(index.table)}(id, embedding) SELECT ${pgSearchName(source.key)}, openclaw_vector(${pgSearchName(source.embedding)}, ${source.dimensions}) FROM ${pgSearchName(source.source)} WHERE octet_length(${pgSearchName(source.embedding)}) > 0`,
    );
  }
}
