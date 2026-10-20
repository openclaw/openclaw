import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { lookupSessionGoalOperation } from "../config/sessions/goals-operations-read.js";
import { assertSqliteSchemaContains } from "../infra/sqlite-schema-contract.test-support.js";
import {
  closeOpenClawAgentDatabasesForTest,
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
} from "./openclaw-agent-db.js";
import { createAgentCreationWitnessFixture } from "./openclaw-agent-execution.creation-fixture.test-support.js";
import { ensureSessionGoalOperationsSchema } from "./openclaw-agent-goal-operations-schema.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";

const previousSchema = OPENCLAW_AGENT_SCHEMA_SQL.replace(
  /CREATE TABLE IF NOT EXISTS session_goal_operations \([\s\S]*?(?=CREATE TABLE IF NOT EXISTS transcript_events \()/u,
  "",
);

function fixture() {
  const options = createAgentCreationWitnessFixture();
  const pathname = openOpenClawAgentDatabase(options).path;
  closeOpenClawAgentDatabasesForTest();
  return { options, pathname };
}

function schemaMetadata(db: DatabaseSync) {
  return {
    version: db.prepare("PRAGMA user_version").get(),
    metadata: db
      .prepare("SELECT schema_version, updated_at FROM schema_meta WHERE meta_key = 'primary'")
      .get(),
  };
}

it("keeps old databases table-free on reads, lazily installs once, and survives older-reader use and candidate reopen", async () => {
  const { options, pathname } = fixture();
  const previous = new DatabaseSync(pathname);
  previous.exec("DROP TABLE session_goal_operations");
  const metadata = schemaMetadata(previous);
  previous.close();

  expect(
    await lookupSessionGoalOperation({
      ...options,
      sessionKey: "agent:main:goal",
      expectedSessionId: "session-1",
      operation: {
        action: "start",
        objective: "finish",
        operationId: "op-1",
        issuedAtMs: Date.now(),
        requestFingerprint: "request-1",
      },
    }),
  ).toBeUndefined();
  const candidate = openOpenClawAgentDatabase(options).db;
  expect(
    candidate.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'session_goal_operations'").get(),
  ).toBeUndefined();
  ensureSessionGoalOperationsSchema(candidate);
  ensureSessionGoalOperationsSchema(candidate);
  candidate
    .prepare("INSERT INTO session_goal_operations VALUES (?, ?, ?, ?, ?, ?)")
    .run("agent:main:goal", "op-1", "session-1", "request-1", "{}", Date.now() + 60_000);
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();

  const olderReader = new DatabaseSync(pathname);
  assertSqliteSchemaContains(olderReader, pathname, previousSchema);
  olderReader.exec("UPDATE schema_meta SET updated_at = updated_at WHERE meta_key = 'primary'");
  expect(schemaMetadata(olderReader)).toEqual(metadata);
  olderReader.close();

  const reopened = openOpenClawAgentDatabase(options).db;
  expect(reopened.prepare("SELECT operation_id FROM session_goal_operations").get()).toEqual({
    operation_id: "op-1",
  });
  expect(reopened.prepare("PRAGMA user_version").get()).toEqual(metadata.version);
});

it("rejects a drifted receipt table instead of treating it as an optional absence", () => {
  const { options, pathname } = fixture();
  const drifted = new DatabaseSync(pathname);
  drifted.exec(
    "DROP TABLE session_goal_operations; CREATE TABLE session_goal_operations (operation_id TEXT NOT NULL PRIMARY KEY) STRICT",
  );
  drifted.close();
  expect(() => openOpenClawAgentDatabase(options)).toThrow(/session_goal_operations|schema/u);
});
