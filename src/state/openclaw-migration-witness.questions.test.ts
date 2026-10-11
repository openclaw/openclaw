import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { getOpenClawAgentMigrationSchema } from "./openclaw-agent-db-schema-helpers.js";
import {
  assertOpenClawMigrationWitnessPreserved,
  captureOpenClawMigrationWitness,
} from "./openclaw-migration-witness.js";

function fixture(version: 25 | 26) {
  const db = new DatabaseSync(":memory:");
  db.exec(getOpenClawAgentMigrationSchema(version));
  db.exec(`PRAGMA user_version = ${version};
    INSERT INTO schema_meta (meta_key, role, schema_version, agent_id, created_at, updated_at)
    VALUES ('primary', 'agent', ${version}, 'main', 1, 1);
    CREATE TABLE retained_plugin_data (payload TEXT) STRICT;
    INSERT INTO retained_plugin_data VALUES ('original');`);
  return db;
}
function addQuestion(db: DatabaseSync) {
  db.exec(`INSERT INTO session_questions (question_id, session_key, session_id, lifecycle_revision,
    definition_json, provenance_json, session_binding_json, continuation_state)
    VALUES ('question', 'agent:main:question', 'session', 'revision', '{}', '{}', '{}', 'pending')`);
}

describe("schema 26 migration witnesses", () => {
  it("accepts only the empty additive question contract while retaining schema 25 content", () => {
    const original = fixture(25);
    const upgraded = fixture(26);
    try {
      const before = captureOpenClawMigrationWitness(original, { role: "agent", agentId: "main" });
      const capture = () =>
        captureOpenClawMigrationWitness(upgraded, { role: "agent", agentId: "main" });
      expect(assertOpenClawMigrationWitnessPreserved(before, capture()).warnings).toEqual([]);
      upgraded.exec("UPDATE retained_plugin_data SET payload = 'changed'");
      expect(() => assertOpenClawMigrationWitnessPreserved(before, capture())).toThrow(
        /changed or lost/u,
      );
      upgraded.exec("UPDATE retained_plugin_data SET payload = 'original'");
      addQuestion(upgraded);
      expect(() => assertOpenClawMigrationWitnessPreserved(before, capture())).toThrow(
        /unclassified question content/u,
      );
    } finally {
      original.close();
      upgraded.close();
    }
  });
  it.each([
    {
      mutation: "DELETE FROM session_canonical_validation_pending",
      retainedTable: "session_canonical_validation_pending",
    },
    {
      mutation: "UPDATE session_key_contract SET canonical_ready = 'changed'",
      retainedTable: "session_key_contract",
    },
  ])(
    "preserves existing schema 25 $retainedTable content during 25→26 migration",
    ({ mutation, retainedTable }) => {
      const original = fixture(25);
      const upgraded = fixture(26);
      try {
        for (const db of [original, upgraded]) {
          // Pending validation deliberately has no node foreign key: it retains work for later admission.
          db.exec(
            "INSERT INTO session_canonical_validation_pending(session_key) VALUES ('agent:main:pending')",
          );
          db.exec("UPDATE session_key_contract SET canonical_ready = 'original'");
        }
        const before = captureOpenClawMigrationWitness(original, {
          role: "agent",
          agentId: "main",
        });
        const capture = () =>
          captureOpenClawMigrationWitness(upgraded, { role: "agent", agentId: "main" });
        expect(assertOpenClawMigrationWitnessPreserved(before, capture()).warnings).toEqual([]);
        upgraded.exec(mutation);
        expect(() => assertOpenClawMigrationWitnessPreserved(before, capture())).toThrow(
          `Migration changed or lost retained database content: ${retainedTable}`,
        );
      } finally {
        original.close();
        upgraded.close();
      }
    },
  );
  it.each([
    {
      sql: "CREATE INDEX extra_question_index ON session_questions(session_id)",
      refusal: /changed or lost retained database schema/u,
    },
    {
      sql: "CREATE TRIGGER extra_question_trigger AFTER INSERT ON session_questions BEGIN SELECT 1; END",
      refusal: /unexpected trigger extra_question_trigger/u,
    },
  ])("rejects an unclassified question schema object during 25→26 preservation: $sql", (extra) => {
    const original = fixture(25);
    const upgraded = fixture(26);
    try {
      const before = captureOpenClawMigrationWitness(original, { role: "agent", agentId: "main" });
      upgraded.exec(extra.sql);
      expect(() =>
        assertOpenClawMigrationWitnessPreserved(
          before,
          captureOpenClawMigrationWitness(upgraded, { role: "agent", agentId: "main" }),
        ),
      ).toThrow(extra.refusal);
    } finally {
      original.close();
      upgraded.close();
    }
  });
  it("retains question content and schema for same-version schema 26 evidence", () => {
    const db = fixture(26);
    try {
      addQuestion(db);
      const capture = () => captureOpenClawMigrationWitness(db, { role: "agent", agentId: "main" });
      const before = capture();
      expect(assertOpenClawMigrationWitnessPreserved(before, capture()).warnings).toEqual([]);
      db.exec("UPDATE session_questions SET definition_json = '{\"changed\":true}'");
      expect(() => assertOpenClawMigrationWitnessPreserved(before, capture())).toThrow(
        /changed or lost/u,
      );
      db.exec("DROP INDEX idx_agent_session_questions_continuation");
      expect(capture).toThrow();
    } finally {
      db.close();
    }
  });
});
