import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { collectSqliteSchemaIssues } from "../infra/sqlite-schema-contract.js";
import {
  getOpenClawStateRuntimeSchema,
  OPENCLAW_STATE_MAINTENANCE_SCHEMA_COMPATIBILITY as maintenanceCompatibility,
  STATE_RUNTIME_SCHEMA_COMPATIBILITY as runtimeCompatibility,
} from "./openclaw-state-schema-compatibility.js";
import { OPENCLAW_STATE_SCHEMA_SQL as fullSchema } from "./openclaw-state-schema.js";

it.each([
  [false, "", []],
  [true, "", []],
  [true, "ALTER TABLE secret_store_entries ADD COLUMN feature_only TEXT NOT NULL DEFAULT ''", []],
  [false, "ALTER TABLE agent_database_leases DROP COLUMN provenance", []],
  [
    false,
    "ALTER TABLE config_machine_state DROP COLUMN updated_at_ms",
    [["missing-column", "config_machine_state.updated_at_ms"]],
  ],
  [
    false,
    "ALTER TABLE config_machine_state ADD COLUMN foreign_column TEXT NOT NULL DEFAULT ''",
    [["unexpected-column", "config_machine_state.foreign_column"]],
  ],
  [
    false,
    "CREATE UNIQUE INDEX runtime_foreign_unique ON config_machine_state(value_json)",
    [["unexpected-unique-index", "runtime_foreign_unique"]],
  ],
  [
    false,
    "DROP INDEX idx_operator_approvals_source_run_resolved",
    [["missing-or-drifted-index", "idx_operator_approvals_source_run_resolved"]],
  ],
] as const)("preserves runtime projection #%# (full=%s, change=%s)", (full, change, issues) => {
  const runtime = getOpenClawStateRuntimeSchema({
    includeVersionLazyAdditiveTables: false,
  });
  using database = new DatabaseSync(":memory:");
  const collect = (compatibility = runtimeCompatibility, schema = fullSchema) =>
    collectSqliteSchemaIssues(database, schema, compatibility);
  database.exec(full ? fullSchema : runtime);
  if (change) {
    database.exec(change);
  }
  const previous = collect(
    {
      ...runtimeCompatibility,
      excludedTables: [],
      excludedIndexes: [],
    },
    runtime,
  );
  const projected = collect();
  expect(projected).toEqual(previous);
  expect(projected.map(({ code, objectName }) => [code, objectName])).toEqual(issues);
  if (full && change) {
    expect(collect(maintenanceCompatibility)).toMatchObject([
      { code: "unexpected-column", objectName: "secret_store_entries.feature_only" },
    ]);
  }
});

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
