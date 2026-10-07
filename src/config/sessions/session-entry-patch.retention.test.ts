import { MessageChannel } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import * as admission from "../../infra/sqlite-worker-operation-admission.js";
import { runOpenClawAgentWriteTransaction } from "../../state/openclaw-agent-db.js";
import { loadAgentTrajectoryOperations } from "../../state/openclaw-agent-execution-operations.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  beginTrajectoryRuntimeRetention,
  prepareTrajectoryRuntimeRetention,
} from "../../trajectory/runtime-retention.sqlite.js";
import { readSessionEntrySelectionSnapshot } from "./session-accessor.sqlite-entry-store.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import { createSessionEntryPatchFixture as fixture } from "./session-entry-patch.test-support.js";
import { commitSessionEntryPatch } from "./session-entry-patch.worker.js";

vi.mock("./session-accessor.sqlite-maintenance-kick.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-accessor.sqlite-maintenance-kick.js")>()),
  kickSessionEntryMaintenanceAfterWrite() {},
}));
vi.mock("./session-history-eviction.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-history-eviction.js")>()),
  kickSessionHistoryDiskBudgetMaintenance() {},
}));

afterEach(() => vi.restoreAllMocks());

it.each([
  { route: "prepared", mode: "commit" },
  { route: "prepared", mode: "replacement" },
  { route: "prepared", mode: "rollback" },
  { route: "prepared", mode: "foreign" },
  { route: "reducer", mode: "commit" },
  { route: "reducer", mode: "replacement" },
] as const)(
  "preserves retention facts without reading trajectory rows during a metadata patch ($route/$mode)",
  async ({ route, mode }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const f = fixture();
      const options = { agentId: f.database.agentId, path: f.database.path };
      replaceSessionEntrySync(
        { ...f.scope, sessionKey: "agent:main:retention-history" },
        { sessionId: "history", updatedAt: 1 },
      );
      f.database.db.exec(`INSERT INTO trajectory_runtime_events
        (session_id, seq, run_id, event_json, created_at) VALUES
        ('original', 0, 'run', '{"type":"protected"}', 1),
        ('history', 0, 'run', '{"type":"expired"}', 1)`);
      const prepared = readSessionEntrySelectionSnapshot(f.database, f.scope.sessionKey, false);
      const writeBase = prepared[0]!.entry;
      const operations = await loadAgentTrajectoryOperations();
      const lease = new Int32Array(new SharedArrayBuffer(4));
      Atomics.store(lease, 0, 1);
      const sweepId = beginTrajectoryRuntimeRetention(f.database.db, lease);
      const snapshot = prepareTrajectoryRuntimeRetention(
        f.database.db,
        { sessionId: "original" },
        Date.now(),
      );
      if (mode === "foreign") {
        const foreign = new (requireNodeSqlite().DatabaseSync)(f.database.path);
        try {
          foreign
            .prepare("UPDATE trajectory_runtime_events SET created_at = ? WHERE session_id = ?")
            .run(Date.now(), "history");
        } finally {
          foreign.close();
        }
      }
      const context: Parameters<typeof commitSessionEntryPatch>[1] = {
        options,
        open: () => f.database,
        admit() {},
        writeTransaction: (operationLabel, _owner, write) =>
          runOpenClawAgentWriteTransaction(write, options, { operationLabel }),
      };
      const counter = trackSqliteStatementExecutions(f.database.db, ["trajectory"], (sql) =>
        /^select\b/i.test(sql) && sql.includes('"trajectory_runtime_events"') ? "trajectory" : null,
      );
      const metadata = {
        label: "metadata committed",
        ...(mode === "replacement" ? { sessionId: "replacement" } : {}),
      };
      const { port1, port2 } = new MessageChannel();
      try {
        const patch = () =>
          admission.withSqliteWorkerOperationAdmission({ port: port1 }, () =>
            commitSessionEntryPatch(
              {
                selection: { kind: "entry", sessionKey: f.scope.sessionKey, exact: false },
                sessionKey: f.scope.sessionKey,
                ...(route === "reducer"
                  ? { operation: { kind: "fields" as const, patch: metadata } }
                  : { prepared, writeBase, next: { ...writeBase, ...metadata } }),
                operationLabel: "session-entry.patch",
                validateCanonicalKeys: false,
              },
              {
                ...context,
                writeTransaction: (operationLabel, owner, write) =>
                  context.writeTransaction(operationLabel, owner, (database) => {
                    const result = write(database);
                    if (mode === "rollback") {
                      throw new Error("synthetic metadata rollback");
                    }
                    return result;
                  }),
              },
            ),
          );
        if (mode === "rollback") {
          expect(patch).toThrow("synthetic metadata rollback");
        } else {
          patch();
        }
        expect(counter.counts.trajectory).toBe(0);
        counter.restore();
        const retained = mode === "commit" || mode === "replacement";
        expect(
          operations["trajectory.retention.delete"]({ sweepId, snapshot }, context),
        ).toMatchObject({ complete: retained, refresh: !retained, deleted: retained ? 1 : 0 });
        expect(f.read()?.label).toBe(mode === "rollback" ? "initial" : "metadata committed");
        expect(
          f.database.db
            .prepare("SELECT session_id FROM trajectory_runtime_events ORDER BY session_id")
            .all(),
        ).toEqual(
          (retained ? ["original"] : ["history", "original"]).map((session_id) => ({ session_id })),
        );
      } finally {
        counter.restore();
        Atomics.store(lease, 0, 0);
        port1.close();
        port2.close();
      }
    });
  },
);
