import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { collectSqliteSchemaIssues } from "../infra/sqlite-schema-contract.js";
import {
  getOpenClawStateRuntimeSchema,
  OPENCLAW_STATE_MAINTENANCE_SCHEMA_COMPATIBILITY,
  STATE_RUNTIME_SCHEMA_COMPATIBILITY,
} from "./openclaw-state-schema-compatibility.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";

type ProjectionCase = {
  name: string;
  full?: boolean;
  change?: string;
  issue?: [code: string, objectName: string];
};

describe("OpenClaw state runtime schema projection", () => {
  it.each([
    { name: "absent lazy tables" },
    { name: "present lazy tables", full: true },
    {
      name: "feature-owned table validation",
      full: true,
      change: "ALTER TABLE secret_store_entries ADD COLUMN feature_only TEXT NOT NULL DEFAULT ''",
    },
    {
      name: "missing first-use column",
      change: "ALTER TABLE agent_database_leases DROP COLUMN provenance",
    },
    {
      name: "missing required column",
      change: "ALTER TABLE config_machine_state DROP COLUMN updated_at_ms",
      issue: ["missing-column", "config_machine_state.updated_at_ms"],
    },
    {
      name: "foreign constrained column",
      change: "ALTER TABLE config_machine_state ADD COLUMN foreign_column TEXT NOT NULL DEFAULT ''",
      issue: ["unexpected-column", "config_machine_state.foreign_column"],
    },
    {
      name: "foreign uniqueness",
      change: "CREATE UNIQUE INDEX runtime_foreign_unique ON config_machine_state(value_json)",
      issue: ["unexpected-unique-index", "runtime_foreign_unique"],
    },
    {
      name: "missing canonical index",
      change: "DROP INDEX idx_operator_approvals_source_run_resolved",
      issue: ["missing-or-drifted-index", "idx_operator_approvals_source_run_resolved"],
    },
  ] satisfies ProjectionCase[])(
    "preserves runtime admission issues for $name",
    ({ name, full = false, change = "", issue }: ProjectionCase) => {
      const runtimeSchema = getOpenClawStateRuntimeSchema({
        includeVersionLazyAdditiveTables: false,
      });
      using database = new DatabaseSync(":memory:");
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
      expect(projected.map(({ code, objectName }) => [code, objectName])).toEqual(
        issue ? [issue] : [],
      );
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
    },
  );

  it.each([false, true])(
    "preserves first-use exclusions with version-lazy tables enabled: %s",
    (includeVersionLazyAdditiveTables) => {
      const schema = getOpenClawStateRuntimeSchema({ includeVersionLazyAdditiveTables });

      for (const fragment of [
        "CREATE TABLE IF NOT EXISTS cron_run_receipts",
        "CREATE TABLE IF NOT EXISTS worker_session_placement_moves",
        "idx_cron_run_receipts_active_job",
        "idx_cron_run_receipts_job_history",
        "CREATE TABLE IF NOT EXISTS github_publication_requests",
        "idx_github_publication_requests_pending",
        "CREATE TABLE IF NOT EXISTS config_revision_keys",
      ]) {
        expect(schema.includes(fragment), fragment).toBe(includeVersionLazyAdditiveTables);
      }
      for (const fragment of [
        "CREATE TABLE IF NOT EXISTS outbound_message_progress",
        "CREATE TABLE IF NOT EXISTS outbound_message_execution_bindings",
        "outbound_message_execution_bindings_execution_event_idx",
        "outbound_message_progress_occurred_idx",
        "outbound_message_progress_run_occurred_idx",
      ]) {
        expect(schema, fragment).not.toContain(fragment);
      }
    },
  );
});
