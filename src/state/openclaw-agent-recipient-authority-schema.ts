import { extractSqliteTableSchema } from "../infra/sqlite-schema-sql.js";

// Continuation (karmaterminal): durable session-key recipient-authority generations sit on top of
// upstream's agent schema 41. Each version check keeps upstream's own historical schema; the
// authority step runs after upstream's steps in the same migration transaction.
export const AGENT_RECIPIENT_AUTHORITY_SCHEMA_VERSION = 42;
export const RECIPIENT_AUTHORITY_TABLE = "session_recipient_authority";

export function sessionRecipientAuthoritySchemaSql(schema: string): string {
  return extractSqliteTableSchema(schema, "session_recipient_authority");
}

/**
 * Historical admission must validate only the tables its schema version supported. The table
 * leaves with its comment and trailing blank line, so each historical schema is upstream's text.
 */
export function withoutSessionRecipientAuthoritySchema(schema: string): string {
  if (!schema.includes("CREATE TABLE IF NOT EXISTS session_recipient_authority (")) {
    return schema;
  }
  const table = sessionRecipientAuthoritySchemaSql(schema);
  const before = schema.slice(0, schema.indexOf(table));
  const comment = /(?:^|\n)((?:--[^\n]*\n)*)$/u.exec(before)?.[1] ?? "";
  const end = before.length + table.length;
  return (
    before.slice(0, before.length - comment.length) +
    schema.slice(schema.startsWith("\n\n", end) ? end + 2 : end)
  );
}

const POSTGRES_AUTHORITY_TABLE_RE = /CREATE TABLE "session_recipient_authority" \([\s\S]*?\n\);\n/;

/** The generated PostgreSQL DDL for the authority table (one statement, no indexes). */
export function sessionRecipientAuthorityPostgresSql(postgres: string): string {
  const statement = POSTGRES_AUTHORITY_TABLE_RE.exec(postgres)?.[0];
  if (!statement) {
    throw new Error("Generated PostgreSQL agent schema lacks session_recipient_authority");
  }
  return statement;
}

/**
 * PostgreSQL schemas before the authority step. The statement's blank-line separator leaves with
 * it, so each historical schema is upstream's exact text.
 */
export function withoutSessionRecipientAuthorityPostgresSchema(postgres: string): string {
  return postgres.replace(`${sessionRecipientAuthorityPostgresSql(postgres)}\n`, "");
}
