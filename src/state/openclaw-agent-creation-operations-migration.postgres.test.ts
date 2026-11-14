import { getEnvironmentData } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withEngineStoreAdmission } from "../infra/database-engine/admission-scope.js";
import { createPostgresEngineTestFixture } from "../infra/database-engine/engine-store.test-support.js";
import { agentEngineSchema } from "./openclaw-agent-db-engine.js";

const configured: unknown = getEnvironmentData("openclaw.test.workboard.connection");
const connection = typeof configured === "string" ? configured : undefined;
const dirs = useAutoCleanupTempDirTracker(afterEach);

describe.skipIf(!connection)("PostgreSQL creation receipt migration", () => {
  it("upgrades populated agent39 without rewriting sessions and admits agent40 on reopen", () => {
    withEngineStoreAdmission(() => {
      const migration = agentEngineSchema.postgresMigrations?.find((step) => step.version === 40);
      if (!migration) {
        throw new Error("Missing agent40 migration");
      }
      const source = {
        ...agentEngineSchema,
        ...migration.fromSchema,
        version: 39,
        postgresMigrations: [],
      };
      using fixture = createPostgresEngineTestFixture({
        directory: dirs.make("creation-receipt-upgrade-"),
        connection: connection!,
        schemaPrefix: "creation_receipt_test",
        schema: source,
      });
      const original = fixture.open();
      const entry = JSON.stringify({
        sessionId: "retained",
        lifecycleRevision: "original",
        updatedAt: 1,
      });
      original.runTransaction(() => {
        original.exec(
          "INSERT INTO schema_meta (meta_key,role,schema_version,agent_id,created_at,updated_at) VALUES ('primary','agent',39,'main',1,1)",
        );
        original
          .prepare(
            "INSERT INTO session_nodes (session_key,current_session_id,entry_json,updated_at) VALUES (?, ?, ?, 1)",
          )
          .run("agent:main:retained", "retained", entry);
      });
      expect(
        original.prepare("SELECT to_regclass('session_creation_operations') AS name").get(),
      ).toEqual({ name: null });
      expect(
        original
          .prepare(
            "SELECT indexname FROM pg_indexes WHERE schemaname=current_schema() AND indexname IN ('idx_agent_session_input_completions_session_key','idx_agent_conversation_deliveries_source_session')",
          )
          .all(),
      ).toEqual([]);
      const before = original.prepare("SELECT entry_json FROM session_nodes").all();
      fixture.invalidate();
      const upgraded = fixture.open(agentEngineSchema);
      expect(
        upgraded.prepare("SELECT version FROM openclaw_schema_meta WHERE store='agent'").get(),
      ).toEqual({ version: 40 });
      expect(upgraded.prepare("SELECT schema_version FROM schema_meta").get()).toEqual({
        schema_version: 40,
      });
      expect(upgraded.prepare("SELECT entry_json FROM session_nodes").all()).toEqual(before);
      expect(upgraded.prepare("SELECT * FROM session_creation_operations").all()).toEqual([]);
      expect(
        upgraded
          .prepare(
            "SELECT indexname FROM pg_indexes WHERE schemaname=current_schema() AND indexname IN ('idx_agent_session_input_completions_session_key','idx_agent_conversation_deliveries_source_session')",
          )
          .all(),
      ).toHaveLength(2);
      upgraded
        .prepare(
          "INSERT INTO session_creation_operations (operation_digest,request_fingerprint,session_key,session_id,lifecycle_revision,role,scopes_json,expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          "original-operation",
          "original-request",
          "agent:main:retained",
          "retained",
          "original",
          "operator",
          '["operator.write"]',
          Date.now() + 300000,
        );
      fixture.invalidate();
      const reopened = fixture.open(agentEngineSchema);
      expect(
        reopened
          .prepare("SELECT session_id,lifecycle_revision FROM session_creation_operations")
          .get(),
      ).toEqual({ session_id: "retained", lifecycle_revision: "original" });
      expect(reopened.prepare("SELECT entry_json FROM session_nodes").all()).toEqual(before);
    });
  });
});
