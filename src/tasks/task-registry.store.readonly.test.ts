import { statSync } from "node:fs";
import { expect, it } from "vitest";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import {
  closeOpenClawStateDatabase,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { getInspectableTaskStatusSummaryReadOnly } from "./task-registry.maintenance.js";
import { loadTaskRegistryStateFromSqliteReadOnly } from "./task-registry.store.sqlite.js";

it("does not create shared state for a read-only task snapshot", async () => {
  await withOpenClawTestState(
    { layout: "state-only", prefix: "openclaw-task-store-readonly-" },
    async () => {
      const statePath = resolveOpenClawStateSqlitePath();
      expect(() => statSync(statePath)).toThrow();

      const snapshot = loadTaskRegistryStateFromSqliteReadOnly();
      expect(snapshot.tasks.size).toBe(0);
      expect(snapshot.deliveryStates.size).toBe(0);
      expect(() => statSync(statePath)).toThrow();
    },
  );
});

it("reports an additive schema migration without querying newer task columns", async () => {
  await withOpenClawTestState(
    { layout: "state-only", prefix: "openclaw-task-store-old-schema-" },
    async () => {
      const database = openOpenClawStateDatabase();
      database.db.exec("ALTER TABLE task_runs DROP COLUMN tool_use_count");
      const schemaSql = "SELECT type, name, sql FROM sqlite_schema ORDER BY name";
      const originalSchema = database.db.prepare(schemaSql).all();
      closeOpenClawStateDatabase();

      expect(loadTaskRegistryStateFromSqliteReadOnly()).toEqual({
        tasks: new Map(),
        deliveryStates: new Map(),
      });
      expect(await getInspectableTaskStatusSummaryReadOnly()).toMatchObject({
        state: "migration-required",
        tasks: { total: 0 },
      });
      const { DatabaseSync } = requireNodeSqlite();
      const readOnly = new DatabaseSync(database.path, { readOnly: true });
      try {
        expect(readOnly.prepare(schemaSql).all()).toEqual(originalSchema);
      } finally {
        readOnly.close();
      }
    },
  );
});
