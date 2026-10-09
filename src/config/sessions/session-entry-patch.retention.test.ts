import "./session-entry-patch-delivery.test-support.js";
import { MessageChannel } from "node:worker_threads";
import { expect, it } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import * as admission from "../../infra/sqlite-worker-operation-admission.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { loadAgentTrajectoryOperations } from "../../state/openclaw-agent-execution-operations.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  beginTrajectoryRuntimeRetention,
  deleteTrajectoryRuntimeRetention,
  prepareTrajectoryRuntimeRetention,
  selectTrajectoryRuntimeRetentionBatch,
} from "../../trajectory/runtime-retention.sqlite.js";
import {
  readExactSessionEntryRow,
  readSessionEntrySelectionSnapshot,
  writeSessionEntry,
} from "./session-accessor.sqlite-entry-store.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import { createSessionCompoundWorkerFixture as fixture } from "./session-compound-worker.test-support.js";
import { commitSessionEntryPatch } from "./session-entry-patch.worker.js";

it.each([
  "metadata",
  "replacement",
  "local before",
  "local after",
  "local before commit",
  "foreign before",
  "foreign after",
  "rollback",
  "revoked lease",
] as const)("preserves retention freshness across an entry patch: %s", async (interleaving) => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    const options = { agentId: database.agentId, path: database.path };
    const sessionKey = "agent:main:patch-worker";
    const now = Date.parse("2026-07-26T00:00:00.000Z");
    runOpenClawAgentWriteTransaction((current) => {
      writeSessionEntry(current, sessionKey, {
        sessionId: "original",
        updatedAt: 1,
        label: "initial",
      });
      writeSessionEntry(current, "agent:main:retention-history", {
        sessionId: "history",
        updatedAt: 1,
      });
      const insert = current.db.prepare(`INSERT INTO trajectory_runtime_events
        (session_id, seq, run_id, event_json, created_at) VALUES (?, 0, 'run', ?, ?)`);
      insert.run("original", '{"type":"current"}', now);
      insert.run("history", '{"type":"expired"}', now - 15 * 24 * 60 * 60 * 1_000);
    }, options);
    const events = () =>
      database.db.prepare("SELECT * FROM trajectory_runtime_events ORDER BY session_id, seq").all();
    const before = events();
    const prepared = readSessionEntrySelectionSnapshot(database, sessionKey, false);
    const writeBase = prepared[0]!.entry;
    const lease = new Int32Array(new SharedArrayBuffer(4));
    Atomics.store(lease, 0, 1);
    const sweepId = beginTrajectoryRuntimeRetention(database.db, lease);
    const snapshot = prepareTrajectoryRuntimeRetention(database.db, { sessionId: "original" }, now);
    const competing = new (requireNodeSqlite().DatabaseSync)(database.path);
    const { port1, port2 } = new MessageChannel();
    const refreshHistory = (connection: typeof database.db) => {
      connection
        .prepare("UPDATE trajectory_runtime_events SET created_at = ? WHERE session_id = 'history'")
        .run(now);
    };
    try {
      if (interleaving === "local before") {
        refreshHistory(database.db);
      } else if (interleaving === "foreign before") {
        refreshHistory(competing);
      }
      const patch = () =>
        admission.withSqliteWorkerOperationAdmission({ port: port1 }, () =>
          commitSessionEntryPatch(
            {
              selection: { kind: "entry", sessionKey, exact: false },
              prepared,
              sessionKey,
              writeBase,
              next: {
                ...writeBase,
                sessionId: interleaving === "replacement" ? "replacement" : "original",
                label: "metadata committed",
                skillsSnapshot: { prompt: "synthetic cold metadata", skills: [] },
              },
              operationLabel: "session-entry.patch",
              validateCanonicalKeys: false,
            },
            {
              options,
              open: () => database,
              admit() {},
              writeTransaction: (operationLabel, _owner, write) =>
                runOpenClawAgentWriteTransaction(
                  (current) => {
                    const result = write(current);
                    if (interleaving === "local before commit") {
                      refreshHistory(current.db);
                    } else if (interleaving === "rollback") {
                      throw new Error("synthetic entry rollback");
                    } else if (interleaving === "revoked lease") {
                      Atomics.store(lease, 0, 0);
                    }
                    return result;
                  },
                  options,
                  { operationLabel },
                ),
            },
          ),
        );
      if (interleaving === "rollback") {
        expect(patch).toThrow("synthetic entry rollback");
        expect(readExactSessionEntryRow(database, sessionKey)?.entry.label).toBe("initial");
      } else {
        patch();
        expect(readExactSessionEntryRow(database, sessionKey)?.entry.label).toBe(
          "metadata committed",
        );
      }
      if (interleaving === "local after") {
        refreshHistory(database.db);
      } else if (interleaving === "foreign after") {
        refreshHistory(competing);
      }
      const unchanged = interleaving === "metadata" || interleaving === "replacement";
      if (unchanged || interleaving === "rollback" || interleaving === "revoked lease") {
        expect(events()).toEqual(before);
      }
      const batch = selectTrajectoryRuntimeRetentionBatch(database.db, { sweepId, snapshot });
      const result = runOpenClawAgentWriteTransaction(
        (current) => deleteTrajectoryRuntimeRetention(current, batch),
        options,
      );
      expect(result).toMatchObject({
        complete: unchanged,
        refresh: !unchanged,
        deleted: unchanged ? 1 : 0,
      });
      expect(events().map((row) => row.session_id)).toEqual(
        unchanged ? ["original"] : ["history", "original"],
      );
    } finally {
      Atomics.store(lease, 0, 0);
      competing.close();
      port1.close();
      port2.close();
    }
  });
});

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
