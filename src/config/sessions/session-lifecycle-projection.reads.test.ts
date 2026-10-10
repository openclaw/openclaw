import { expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { loadSubagentMaintenanceRunsInDatabase } from "../../agents/subagents/registry/subagent-registry.store.sqlite.js";
import { runWithSqliteWorkerStateContext } from "../../infra/sqlite-worker-state-context.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { requireOpenClawStateDatabaseIdentity } from "../../state/openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { assertSessionSubagentRunsCurrent } from "./session-accessor.sqlite-descendant-basis.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import { bindSqliteWorkerBackend } from "./session-lifecycle-projection.worker.js";

it("keeps upsert preparation current without a read transaction and retains removal snapshots", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    const sessionKey = "agent:main:lifecycle-planning";
    writeSessionEntry(database, sessionKey, { sessionId: "original", updatedAt: 1 });
    const backend = runWithSqliteWorkerStateContext(
      { environment: { ...state.env, OPENCLAW_STATE_DIR: state.stateDir } },
      () =>
        bindSqliteWorkerBackend(
          { agentId: "main" },
          { database: database.db, databasePath: database.path },
        ),
    );
    const input = { removals: [], upsertSessionKeys: [sessionKey], archiveDirectory: state.root };
    backend.execute({ type: "prepare", input });
    writeSessionEntry(database, sessionKey, { sessionId: "current", updatedAt: 2 });
    const exec = vi.spyOn(database.db, "exec");
    try {
      const prepared = backend.execute({ type: "prepare", input });
      expect(prepared).toMatchObject({
        store: { [sessionKey]: { sessionId: "current", updatedAt: 2 } },
        archiveRecovery: { pending: false },
      });
      expect(exec.mock.calls).toEqual([]);
      const removal = backend.execute({
        type: "prepare",
        input: { ...input, removals: [{ sessionKey, expectedSessionId: "current" }] },
      });
      expect(removal).toMatchObject({
        selected: {
          projectedRemovals: [{ sessionKey, expectedEntry: { sessionId: "current" } }],
        },
      });
      expect(exec.mock.calls.map(([sql]) => sql)).toEqual(["BEGIN", "COMMIT"]);
      backend.assertSettled?.();
    } finally {
      exec.mockRestore();
      await backend.close();
    }
  });
});

it("rechecks durable maintenance authority in one statement after an owning-process write", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const shared = openOpenClawStateDatabase();
    const identity = requireOpenClawStateDatabaseIdentity(shared);
    const params = {
      maintenanceRunBasis: {
        databasePath: shared.path,
        databaseIdentity: identity.key,
        databaseBirthtime: identity.birthtime,
        digest: loadSubagentMaintenanceRunsInDatabase(shared).digest,
      },
    };
    assertSessionSubagentRunsCurrent(params, state.env);
    const observed = observeHostDataSql();
    try {
      assertSessionSubagentRunsCurrent(params, state.env);
      expect(
        observed.queries.filter((sql) => /^(?:BEGIN|COMMIT|SAVEPOINT|RELEASE)\b/iu.test(sql)),
      ).toEqual([]);
      // Physical rows participate in the guard even when their payload cannot decode.
      shared.db
        .prepare(
          "INSERT INTO subagent_runs (run_id, child_session_key, requester_session_key, created_at, payload_json) VALUES (?, ?, ?, ?, ?)",
        )
        .run("new-child", "agent:main:subagent:child", "agent:main:parent", 1, "{}");
      expect(() => assertSessionSubagentRunsCurrent(params, state.env)).toThrow(
        "SQLite session state changed while preparing session maintenance",
      );
    } finally {
      observed.restore();
    }
  });
});
