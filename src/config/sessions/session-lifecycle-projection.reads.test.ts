import { expect, it, vi } from "vitest";
import { runWithSqliteWorkerStateContext } from "../../infra/sqlite-worker-state-context.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
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
