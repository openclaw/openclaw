import { expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { runWithSqliteWorkerStateContext } from "../../infra/sqlite-worker-state-context.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { resolveStateDir } from "../paths.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import { withActor } from "./session-actor-worker.test-support.js";
import type { SessionLifecycleProjectionCommit } from "./session-lifecycle-projection.types.js";
import { bindSqliteWorkerBackend } from "./session-lifecycle-projection.worker.js";
import { SessionEntryLifecycleUpsertConflictError } from "./session-mutation-conflict-error.js";

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
    const input = { removals: [], upserts: [{ sessionKey }], archiveDirectory: state.root };
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

it("reuses lifecycle actor facts and falls back after another writer or actor restart", async () => {
  await withActor(async (f) => {
    const sessionKey = f.target.sessionKey;
    const original = f.read().entry!;
    const backend = runWithSqliteWorkerStateContext(
      { environment: { ...process.env, OPENCLAW_STATE_DIR: resolveStateDir() } },
      () =>
        bindSqliteWorkerBackend(
          { agentId: "main" },
          { database: f.database.db, databasePath: f.database.path },
        ),
    );
    const input = {
      removals: [],
      upserts: [{ sessionKey, relatedSessionKeys: [] }],
      archiveDirectory: "/synthetic/archives",
    };
    const commit: SessionLifecycleProjectionCommit = {
      agentId: "main",
      projected: {
        deletePlans: [],
        removals: [],
        upsertedEntries: [{ sessionKey, expectedEntry: original, entry: original }],
      },
      removalPlans: [],
      materializationFailed: false,
      maintenance: null,
    };
    const reads = trackSqliteStatementExecutions(f.database.db, ["entries"], (sql) =>
      /\bselect\b[\s\S]*\bfrom "session_nodes"/iu.test(sql) && !/\bcount\(/iu.test(sql)
        ? "entries"
        : null,
    );
    try {
      expect(backend.execute({ type: "prepare", input })).toMatchObject({
        store: { [sessionKey]: original },
      });
      f.commitLifecycle(commit);
      expect(reads.counts.entries).toBe(0);

      writeSessionEntry(f.database, sessionKey, { ...original, label: "concurrent winner" });
      expect(backend.execute({ type: "prepare", input })).toMatchObject({
        store: { [sessionKey]: { label: "concurrent winner" } },
      });
      expect(reads.counts.entries).toBeGreaterThan(0);
      expect(() => f.commitLifecycle(commit)).toThrow(SessionEntryLifecycleUpsertConflictError);
      expect(f.nativeEntry()?.label).toBe("concurrent winner");

      const current = f.read().entry!;
      commit.projected.upsertedEntries = [
        { sessionKey, expectedEntry: current, entry: { ...current, label: "lifecycle winner" } },
      ];
      f.hooks.admit = (stage) => {
        if (stage === "commit") {
          throw new Error("lifecycle authority revoked");
        }
      };
      expect(() => f.commitLifecycle(commit)).toThrow("lifecycle authority revoked");
      delete f.hooks.admit;
      expect(f.read().entry?.label).toBe("concurrent winner");
      f.commitLifecycle(commit);
      expect(f.read().entry?.label).toBe("lifecycle winner");
      const beforeRestart = reads.counts.entries;
      f.restartActor();
      expect(backend.execute({ type: "prepare", input })).toMatchObject({
        store: { [sessionKey]: { label: "lifecycle winner" } },
      });
      expect(reads.counts.entries).toBeGreaterThan(beforeRestart);
      backend.assertSettled?.();
    } finally {
      reads.restore();
      await backend.close();
    }
  });
});
