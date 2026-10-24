export const DURABLE_QUESTIONS_SCHEMA_VERSION = 33;

function sessionQuestionsSchemaRange(schema: string) {
  const start = schema.indexOf("CREATE TABLE IF NOT EXISTS session_questions (");
  const end = schema.indexOf("CREATE TABLE IF NOT EXISTS transcript_events (", start);
  if (start < 0 || end < 0) {
    throw new Error("OpenClaw question schema markers are missing.");
  }
  return { start, end };
}

/** The migration owner installs the exact canonical question table and indexes. */
export function sessionQuestionsSchemaSql(schema: string): string {
  const { start, end } = sessionQuestionsSchemaRange(schema);
  return schema.slice(start, end);
}

/** Historical contracts must not acquire durable question custody implicitly. */
export function withoutSessionQuestionsSchema(schema: string): string {
  const { start, end } = sessionQuestionsSchemaRange(schema);
  return schema.slice(0, start) + schema.slice(end);
}

// Canonical generated PostgreSQL separates table creation from named indexes.
const questionPostgresStatements =
  /^CREATE TABLE "session_questions" \([\s\S]*?^\);$|^CREATE (?:UNIQUE )?INDEX "idx_agent_session_questions_(?:pending|continuation)"[^\n]*;$/gm;

export function sessionQuestionsPostgresSchemaSql(schema: string): string {
  const statements = [...schema.matchAll(questionPostgresStatements)].map((match) => match[0]);
  if (statements.length !== 3) {
    throw new Error("OpenClaw PostgreSQL question schema markers are missing.");
  }
  return statements.join("\n\n");
}

export function withoutSessionQuestionsPostgresSchema(schema: string): string {
  return schema.replace(questionPostgresStatements, "");
}
