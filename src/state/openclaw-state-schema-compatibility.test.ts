import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { collectSqliteSchemaIssues } from "../infra/sqlite-schema-contract.js";
import {
  getOpenClawStateRuntimeSchema,
  OPENCLAW_STATE_MAINTENANCE_SCHEMA_COMPATIBILITY,
  STATE_RUNTIME_SCHEMA_COMPATIBILITY,
} from "./openclaw-state-schema-compatibility.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";

describe("OpenClaw state runtime schema projection", () => {
  it.each([
    { name: "absent lazy tables", full: false, change: "", issues: [] },
    { name: "present lazy tables", full: true, change: "", issues: [] },
    {
      name: "feature-owned table validation",
      full: true,
      change: "ALTER TABLE secret_store_entries ADD COLUMN feature_only TEXT NOT NULL DEFAULT ''",
      issues: [],
    },
    {
      name: "missing first-use column",
      full: false,
      change: "ALTER TABLE agent_database_leases DROP COLUMN provenance",
      issues: [],
    },
    {
      name: "missing required column",
      full: false,
      change: "ALTER TABLE config_machine_state DROP COLUMN updated_at_ms",
      issues: [{ code: "missing-column", objectName: "config_machine_state.updated_at_ms" }],
    },
    {
      name: "foreign constrained column",
      full: false,
      change: "ALTER TABLE config_machine_state ADD COLUMN foreign_column TEXT NOT NULL DEFAULT ''",
      issues: [{ code: "unexpected-column", objectName: "config_machine_state.foreign_column" }],
    },
    {
      name: "foreign uniqueness",
      full: false,
      change: "CREATE UNIQUE INDEX runtime_foreign_unique ON config_machine_state(value_json)",
      issues: [{ code: "unexpected-unique-index", objectName: "runtime_foreign_unique" }],
    },
    {
      name: "missing canonical index",
      full: false,
      change: "DROP INDEX idx_operator_approvals_source_run_resolved",
      issues: [
        {
          code: "missing-or-drifted-index",
          objectName: "idx_operator_approvals_source_run_resolved",
        },
      ],
    },
  ])("preserves runtime admission issues for $name", ({ name, full, change, issues }) => {
    const runtimeSchema = getOpenClawStateRuntimeSchema({
      includeVersionLazyAdditiveTables: false,
    });
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(full ? OPENCLAW_STATE_SCHEMA_SQL : runtimeSchema);
      if (change) {
        database.exec(change);
      }
      const previous = collectSqliteSchemaIssues(database, runtimeSchema, {
        ...STATE_RUNTIME_SCHEMA_COMPATIBILITY,
        excludedTables: [],
        excludedIndexes: [],
      });
      const projected = collectSqliteSchemaIssues(
        database,
        OPENCLAW_STATE_SCHEMA_SQL,
        STATE_RUNTIME_SCHEMA_COMPATIBILITY,
      );
      expect(projected).toEqual(previous);
      expect(projected.map(({ code, objectName }) => ({ code, objectName }))).toEqual(issues);
      if (name === "feature-owned table validation") {
        expect(
          collectSqliteSchemaIssues(
            database,
            OPENCLAW_STATE_SCHEMA_SQL,
            OPENCLAW_STATE_MAINTENANCE_SCHEMA_COMPATIBILITY,
          ),
        ).toMatchObject([
          { code: "unexpected-column", objectName: "secret_store_entries.feature_only" },
        ]);
      }
    } finally {
      database.close();
    }
  });

  it.each([false, true])(
    "preserves first-use exclusions with version-lazy tables enabled: %s",
    (includeVersionLazyAdditiveTables) => {
      const schema = getOpenClawStateRuntimeSchema({ includeVersionLazyAdditiveTables });

      expect(schema.includes("CREATE TABLE IF NOT EXISTS cron_run_receipts")).toBe(
        includeVersionLazyAdditiveTables,
      );
      expect(schema.includes("CREATE TABLE IF NOT EXISTS worker_session_placement_moves")).toBe(
        includeVersionLazyAdditiveTables,
      );
      expect(schema.includes("idx_cron_run_receipts_active_job")).toBe(
        includeVersionLazyAdditiveTables,
      );
      expect(schema.includes("idx_cron_run_receipts_job_history")).toBe(
        includeVersionLazyAdditiveTables,
      );
      expect(schema).not.toContain("CREATE TABLE IF NOT EXISTS outbound_message_progress");
      expect(schema).not.toContain(
        "CREATE TABLE IF NOT EXISTS outbound_message_execution_bindings",
      );
      expect(schema).not.toContain("outbound_message_execution_bindings_execution_event_idx");
      expect(schema).not.toContain("outbound_message_progress_occurred_idx");
      expect(schema).not.toContain("outbound_message_progress_run_occurred_idx");
      expect(schema.includes("CREATE TABLE IF NOT EXISTS github_publication_requests")).toBe(
        includeVersionLazyAdditiveTables,
      );
      expect(schema.includes("idx_github_publication_requests_pending")).toBe(
        includeVersionLazyAdditiveTables,
      );
      expect(schema.includes("CREATE TABLE IF NOT EXISTS config_revision_keys")).toBe(
        includeVersionLazyAdditiveTables,
      );
    },
  );
});
