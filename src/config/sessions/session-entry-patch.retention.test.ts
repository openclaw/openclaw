import "./session-entry-patch-delivery.test-support.js";
import { MessageChannel } from "node:worker_threads";
import { expect, it } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import * as admission from "../../infra/sqlite-worker-operation-admission.js";
import { runOpenClawAgentWriteTransaction } from "../../state/openclaw-agent-db.js";
import { createAgentWorkerTestLoaders } from "../../state/openclaw-agent-execution-operations.test-support.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  beginTrajectoryRuntimeRetention,
  deleteTrajectoryRuntimeRetention,
  prepareTrajectoryRuntimeRetention,
  selectTrajectoryRuntimeRetentionBatch,
} from "../../trajectory/runtime-retention.sqlite.js";
import { readSessionEntrySelectionSnapshot } from "./session-accessor.sqlite-entry-store.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import { createSessionCompoundWorkerFixture as fixture } from "./session-compound-worker.test-support.js";
import { commitSessionEntryPatch } from "./session-entry-patch.worker.js";

it.each([
  { route: "prepared", interleaving: "metadata", deletion: "direct" },
  { route: "prepared", interleaving: "replacement", deletion: "direct" },
  { route: "prepared", interleaving: "local before", deletion: "direct" },
  { route: "prepared", interleaving: "local after", deletion: "direct" },
  { route: "prepared", interleaving: "local before commit", deletion: "direct" },
  { route: "prepared", interleaving: "foreign before", deletion: "direct" },
  { route: "prepared", interleaving: "foreign after", deletion: "direct" },
  { route: "prepared", interleaving: "rollback", deletion: "direct" },
  { route: "prepared", interleaving: "revoked lease", deletion: "direct" },
  { route: "prepared", interleaving: "metadata", deletion: "worker" },
  { route: "prepared", interleaving: "replacement", deletion: "worker" },
  { route: "prepared", interleaving: "rollback", deletion: "worker" },
  { route: "prepared", interleaving: "foreign before", deletion: "worker" },
  { route: "reducer", interleaving: "metadata", deletion: "worker" },
  { route: "reducer", interleaving: "replacement", deletion: "worker" },
] as const)(
  "preserves retention without trajectory reads ($route/$interleaving/$deletion)",
  async ({ route, interleaving, deletion }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const f = fixture();
      const { database, scope } = f;
      const options = { agentId: database.agentId, path: database.path };
      const now = Date.parse("2026-07-26T00:00:00.000Z");
      replaceSessionEntrySync(
        { ...scope, sessionKey: "agent:main:retention-history" },
        { sessionId: "history", updatedAt: 1 },
      );
      const insert = database.db.prepare(
        "INSERT INTO trajectory_runtime_events (session_id, seq, run_id, event_json, created_at) VALUES (?, 0, 'run', ?, ?)",
      );
      insert.run("original", '{"type":"current"}', now);
      insert.run("history", '{"type":"expired"}', now - 15 * 24 * 60 * 60 * 1_000);
      const events = () =>
        database.db
          .prepare("SELECT * FROM trajectory_runtime_events ORDER BY session_id, seq")
          .all();
      const before = events();
      const prepared = readSessionEntrySelectionSnapshot(database, scope.sessionKey, false);
      const writeBase = prepared[0]!.entry;
      const lease = new Int32Array(new SharedArrayBuffer(4));
      Atomics.store(lease, 0, 1);
      const sweepId = beginTrajectoryRuntimeRetention(database.db, lease);
      const snapshot = prepareTrajectoryRuntimeRetention(
        database.db,
        { sessionId: "original" },
        now,
      );
      const competing = new (requireNodeSqlite().DatabaseSync)(database.path);
      const { port1, port2 } = new MessageChannel();
      const refreshHistory = (connection: typeof database.db) =>
        connection
          .prepare(
            "UPDATE trajectory_runtime_events SET created_at = ? WHERE session_id = 'history'",
          )
          .run(now);
      const context: Parameters<typeof commitSessionEntryPatch>[1] = {
        options,
        open: () => database,
        admit() {},
        writeTransaction: (operationLabel, _owner, write) =>
          runOpenClawAgentWriteTransaction(write, options, { operationLabel }),
      };
      const operations =
        await createAgentWorkerTestLoaders(context)["trajectory.retention.delete"]();
      const counter =
        deletion === "worker"
          ? trackSqliteStatementExecutions(database.db, ["trajectory"], (sql) =>
              /^select\b/i.test(sql) && sql.includes('"trajectory_runtime_events"')
                ? "trajectory"
                : null,
            )
          : undefined;
      try {
        if (interleaving === "local before") {
          refreshHistory(database.db);
        } else if (interleaving === "foreign before") {
          refreshHistory(competing);
        }
        const metadata = {
          label: "metadata committed",
          ...(interleaving === "replacement" ? { sessionId: "replacement" } : {}),
        };
        const patch = () =>
          admission.withSqliteWorkerOperationAdmission({ port: port1 }, () =>
            commitSessionEntryPatch(
              {
                selection: { kind: "entry", sessionKey: scope.sessionKey, exact: false },
                sessionKey: scope.sessionKey,
                ...(route === "reducer"
                  ? { operation: { kind: "fields" as const, patch: metadata } }
                  : {
                      prepared,
                      writeBase,
                      next: {
                        ...writeBase,
                        ...metadata,
                        ...(deletion === "direct"
                          ? { skillsSnapshot: { prompt: "synthetic cold metadata", skills: [] } }
                          : {}),
                      },
                    }),
                operationLabel: "session-entry.patch",
                validateCanonicalKeys: false,
              },
              {
                ...context,
                writeTransaction: (operationLabel, owner, write) =>
                  context.writeTransaction(operationLabel, owner, (current) => {
                    const result = write(current);
                    if (interleaving === "local before commit") {
                      refreshHistory(current.db);
                    } else if (interleaving === "rollback") {
                      throw new Error("synthetic entry rollback");
                    } else if (interleaving === "revoked lease") {
                      Atomics.store(lease, 0, 0);
                    }
                    return result;
                  }),
              },
            ),
          );
        if (interleaving === "rollback") {
          expect(patch).toThrow("synthetic entry rollback");
        } else {
          patch();
        }
        if (counter) {
          expect(counter.counts.trajectory).toBe(0);
          counter.restore();
        }
        expect(f.read()?.label).toBe(
          interleaving === "rollback" ? "initial" : "metadata committed",
        );
        if (interleaving === "local after") {
          refreshHistory(database.db);
        } else if (interleaving === "foreign after") {
          refreshHistory(competing);
        }
        const unchanged = interleaving === "metadata" || interleaving === "replacement";
        if (unchanged || interleaving === "rollback" || interleaving === "revoked lease") {
          expect(events()).toEqual(before);
        }
        const prune = () => {
          if (deletion === "worker") {
            return operations["trajectory.retention.delete"]({ sweepId, snapshot }, context);
          }
          const batch = selectTrajectoryRuntimeRetentionBatch(database.db, { sweepId, snapshot });
          return runOpenClawAgentWriteTransaction(
            (current) => deleteTrajectoryRuntimeRetention(current, batch),
            options,
          );
        };
        const result = prune();
        expect(result).toMatchObject({
          complete: unchanged,
          refresh: !unchanged,
          deleted: unchanged ? 1 : 0,
        });
        expect(events().map((row) => row.session_id)).toEqual(
          unchanged ? ["original"] : ["history", "original"],
        );
      } finally {
        counter?.restore();
        Atomics.store(lease, 0, 0);
        competing.close();
        port1.close();
        port2.close();
      }
    });
  },
);
