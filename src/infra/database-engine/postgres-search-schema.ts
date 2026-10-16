import type { PostgresSqlConnection } from "../sql-connection.js";
import {
  getSqliteDatabaseAdmission,
  publishSqliteDatabaseAdmission,
  type SqliteDatabaseAdmissionKey,
} from "../sqlite-database-admission.js";
import type { SearchSchema } from "./contract.js";

export const pgSearchName = (name: string) => `"${name.replaceAll('"', '""')}"`;
export const searchConfig = "openclaw_simple_unaccent";
const key: SqliteDatabaseAdmissionKey<string> = {
  name: "database.postgres.search",
  schemaDependent: true,
  read: (value) => (typeof value === "string" ? value : undefined),
};

/** Called only by store admission; query paths consume these retained facts. */
export function admitPostgresSearch(
  db: PostgresSqlConnection,
  schema: SearchSchema,
  namespace: string,
): (() => void) | undefined {
  const signature = JSON.stringify(schema);
  const retained = getSqliteDatabaseAdmission(db, key);
  if (retained === signature) {
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
    .prepare(`SELECT a.name, e.extname, n.nspname FROM pg_catalog.pg_available_extensions a
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
      throw new Error(
        `PostgreSQL ${name} capability unavailable. ${action}: CREATE EXTENSION IF NOT EXISTS ${pgSearchName(name)} WITH SCHEMA ${pgSearchName(extensionSchema)};${name === "vector" ? ' For keyword-only memory explicitly set memory.search.provider to "none".' : ""}`,
      );
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
  return () => publishSqliteDatabaseAdmission(db, key, signature);
}

export function assertPostgresSearchAdmitted(
  db: PostgresSqlConnection,
  schema: SearchSchema,
): void {
  if (!db.isOpen || getSqliteDatabaseAdmission(db, key) !== JSON.stringify(schema)) {
    throw new Error(
      "PostgreSQL search requires matching store admission; reopen the store with its search schema.",
    );
  }
}

/** Deterministic derived DDL joins the store's generated DDL hash and exact catalog seal. */
export function postgresSearchSql(schema: SearchSchema, namespace: string): string {
  const ext = pgSearchName(schema.extensionSchema ?? "public");
  const config = `${pgSearchName(namespace)}.${pgSearchName(searchConfig)}`;
  const configLiteral = `'${config.replaceAll("'", "''")}'`;
  const statements: string[] = [];
  if (Object.keys(schema.text ?? {}).length) {
    statements.push(`CREATE TEXT SEARCH CONFIGURATION ${config} (COPY = pg_catalog.simple);
ALTER TEXT SEARCH CONFIGURATION ${config} ALTER MAPPING FOR hword, hword_part, word, numword, numhword, hword_numpart WITH ${ext}.unaccent, pg_catalog.simple;`);
  }
  for (const index of Object.values(schema.text ?? {})) {
    if (!index.postgres || index.fields.length !== 1) {
      throw new Error("PostgreSQL text index requires one field and a declared source identity");
    }
    const table = pgSearchName(index.table),
      field = pgSearchName(index.fields[0]!);
    statements.push(`ALTER TABLE ${table} ADD COLUMN openclaw_search tsvector GENERATED ALWAYS AS (to_tsvector(${configLiteral}::regconfig, coalesce(${field}, ''))) STORED;
CREATE INDEX ${pgSearchName(`${index.table}_search_gin`)} ON ${table} USING gin(openclaw_search);`);
    if (index.postgres.mode === "trigram") {
      statements.push(
        `CREATE INDEX ${pgSearchName(`${index.table}_trgm_gin`)} ON ${table} USING gin(${field} ${ext}.gin_trgm_ops);`,
      );
    }
  }
  if (schema.mode === "keyword-only") {
    return statements.join("\n");
  }
  if (Object.keys(schema.vector ?? {}).length) {
    // Canonical bytes are IEEE754 little-endian binary64. Only this derived value rounds to float32.
    statements.push(`CREATE FUNCTION openclaw_vector(bytes bytea, dimensions integer) RETURNS ${ext}.vector
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
END $$;`);
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
    const project = `INSERT INTO ${table}(id, embedding) SELECT ${id}, openclaw_vector(${embedding}, ${source.dimensions}) FROM ${owner} WHERE ${embedding} IS NOT NULL`;
    statements.push(`CREATE TABLE ${table} (id TEXT PRIMARY KEY REFERENCES ${owner}(${id}) ON UPDATE CASCADE ON DELETE CASCADE, embedding ${ext}.vector(${source.dimensions}) NOT NULL);
CREATE FUNCTION ${pgSearchName(`${index.table}_sync`)}() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM ${table} WHERE id = NEW.${id};
  IF NEW.${embedding} IS NOT NULL THEN INSERT INTO ${table}(id, embedding) VALUES (NEW.${id}, openclaw_vector(NEW.${embedding}, ${source.dimensions})); END IF;
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
      `DELETE FROM ${pgSearchName(index.table)}; INSERT INTO ${pgSearchName(index.table)}(id, embedding) SELECT ${pgSearchName(source.key)}, openclaw_vector(${pgSearchName(source.embedding)}, ${source.dimensions}) FROM ${pgSearchName(source.source)} WHERE ${pgSearchName(source.embedding)} IS NOT NULL`,
    );
  }
}
