import path from "node:path";
import type { Worker } from "node:worker_threads";
import { afterEach, expect, test, vi } from "vitest";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { measureSessionPhysicalDiskUsage } from "./disk-budget.js";
import { replaceSessionEntry } from "./session-accessor.js";
import * as archiveWorker from "./session-accessor.sqlite-archive.js";
import * as reclamation from "./session-accessor.sqlite-reclamation.js";
import { reclaimSqliteFreePages } from "./session-history-archive-pruning.js";
import { enforceSqliteSessionHistoryDiskBudget } from "./session-history-eviction.js";

afterEach(() => {
  vi.restoreAllMocks();
});

test.each([false, true])(
  "reuses one Worker across history and cap-entry victims until lifecycle close (failure: %s)",
  async (failure) => {
    await withOpenClawTestState(
      { prefix: "reclamation-sweep-", layout: "state-only" },
      async (state) => {
        const sessionKey = "agent:main:explicit:sweep-lifetime";
        const storePath = path.join(state.sessionsDir(), "sessions.json");
        const databaseOptions = { agentId: "main", env: state.env };
        for (const [index, sessionId] of ["first", "second", "current"].entries()) {
          await replaceSessionEntry(
            { sessionKey, storePath },
            {
              sessionId,
              updatedAt: index + 1,
              ...(sessionId === "current"
                ? { archivedAt: 4, archiveReason: "active-session-cap" as const }
                : {}),
            },
          );
        }
        await closeOpenClawAgentDatabasesAsync(state.root);
        await reclaimSqliteFreePages(databaseOptions);
        const workers: Worker[] = [];
        const spawn = archiveWorker.createSqliteTranscriptArchiveWorker;
        vi.spyOn(archiveWorker, "createSqliteTranscriptArchiveWorker").mockImplementation(
          (data) => {
            const worker = spawn(data);
            workers.push(worker);
            return worker;
          },
        );
        const run = reclamation.runSqliteSessionReclamation;
        vi.spyOn(reclamation, "runSqliteSessionReclamation").mockImplementation(async (params) => {
          if (
            failure &&
            params.plan.kind === "history-eviction" &&
            params.plan.sessionId === "second"
          ) {
            throw new Error("next victim preparation failed");
          }
          return run(params);
        });
        const sweep = enforceSqliteSessionHistoryDiskBudget({
          storePath,
          mode: "enforce",
          maintenance: { maxDiskBytes: 1, highWaterBytes: 1 },
        });
        if (failure) {
          await expect(sweep).rejects.toThrow("next victim preparation failed");
        } else {
          const result = await sweep;
          expect(result?.removedEntries).toBe(3);
          expect(result?.totalBytesAfter).toBe(
            (await measureSessionPhysicalDiskUsage(storePath)).totalBytes,
          );
        }
        expect(
          openOpenClawAgentDatabase(databaseOptions)
            .db.prepare("SELECT session_id FROM session_windows ORDER BY session_id")
            .all(),
        ).toEqual(failure ? [{ session_id: "current" }, { session_id: "second" }] : []);
        expect(workers).toHaveLength(1);
        expect(workers[0]?.threadId).toBeGreaterThan(0);
        await closeOpenClawAgentDatabasesAsync(state.root);
        expect(workers[0]?.threadId).toBe(-1);
      },
    );
  },
);
