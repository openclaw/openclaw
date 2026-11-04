import { expect, it } from "vitest";
import { runWithSqliteWorkerStateContext } from "../../infra/sqlite-worker-state-context.js";
import { resolveStateDir } from "../paths.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import { withActor } from "./session-actor-worker.test-support.js";
import { bindSqliteWorkerBackend } from "./session-lifecycle-projection.worker.js";

it("prepares current lifecycle facts and removal snapshots across competing writes and restart", async () => {
  await withActor(async (f) => {
    const sessionKey = f.target.sessionKey;
    const original = f.read().entry!;
    const backend = runWithSqliteWorkerStateContext(
      { environment: { ...process.env, OPENCLAW_STATE_DIR: resolveStateDir() } },
      () =>
        bindSqliteWorkerBackend(
          { agentId: "main" },
          {
            database: f.database.db,
            databasePath: f.database.path,
          },
        ),
    );
    const input = {
      removals: [],
      upserts: [{ sessionKey, relatedSessionKeys: [] }],
      archiveDirectory: "/synthetic/archives",
    };
    const expectPrepared = (entry: Partial<typeof original>) =>
      expect(backend.execute({ type: "prepare", input })).toMatchObject({
        store: { [sessionKey]: entry },
        archiveRecovery: { pending: false },
      });
    try {
      expectPrepared(original);

      const winner = {
        ...original,
        sessionId: "current",
        updatedAt: 2,
        label: "concurrent winner",
      };
      writeSessionEntry(f.database, sessionKey, winner);
      expectPrepared(winner);
      expect(
        backend.execute({
          type: "prepare",
          input: { ...input, removals: [{ sessionKey, expectedSessionId: winner.sessionId }] },
        }),
      ).toMatchObject({
        selected: {
          projectedRemovals: [{ sessionKey, expectedEntry: { sessionId: winner.sessionId } }],
        },
      });
      f.restartActor();
      expectPrepared(winner);
      backend.assertSettled?.();
    } finally {
      await backend.close();
    }
  });
});
