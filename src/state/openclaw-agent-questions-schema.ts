export const DURABLE_QUESTIONS_SCHEMA_VERSION = 26;

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
