import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import type { SqliteWalReclamationResult } from "../../infra/sqlite-wal-reclamation.js";
import * as tmpDirOwner from "../../infra/tmp-openclaw-dir.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { measureSessionPhysicalDiskUsage } from "./disk-budget.js";
import {
  loadSessionEntryReadOnly,
  patchSessionEntryCore,
} from "./session-accessor.sqlite-entry.js";
import * as pageReclamation from "./session-accessor.sqlite-page-reclamation.js";
import { loadTranscriptEventsSync } from "./session-accessor.sqlite-read.js";
import { createSessionHistoryBudgetFixture } from "./session-history-budget.test-support.js";
import { enforceSqliteSessionHistoryDiskBudget } from "./session-history-eviction.js";

it("admits a session patch between worker page-reclamation passes", async () => {
  let fixtureRoot = "";
  let pagesAtPatchCompletion: number | undefined;
  const pageResults: SqliteWalReclamationResult[] = [];
  await withOpenClawTestState(
    { prefix: "session-history-writer-fairness-", scenario: "minimal", layout: "state-only" },
    async (state) => {
      fixtureRoot = state.root;
      const tempDir = state.sessionsDir();
      fs.mkdirSync(tempDir, { recursive: true });
      const storePath = path.join(tempDir, "sessions.json");
      const temporaryRoot = vi
        .spyOn(tmpDirOwner, "resolvePreferredOpenClawTmpDir")
        .mockReturnValue(state.root);
      const { createHistoricalTranscript, database, sessionExists, readArchiveNames } =
        createSessionHistoryBudgetFixture(() => ({ storePath, tempDir }));
      const sessionKey = "agent:main:writer-fairness";
      const historical = { sessionKey, sessionId: "fairness-history", storePath };
      const target = { agentId: "main", sessionKey, storePath };
      let maintenance: ReturnType<typeof enforceSqliteSessionHistoryDiskBudget> | undefined;
      let patch: ReturnType<typeof patchSessionEntryCore> | undefined;
      const withPages = pageReclamation.withSqliteSessionPageReclamation;
      const pages = vi
        .spyOn(pageReclamation, "withSqliteSessionPageReclamation")
        .mockImplementation(<T>(...args: Parameters<typeof withPages<T>>) => {
          const [input, run] = args;
          return withPages(input, (reclaim, ...context) =>
            run(
              async (maxPages) => {
                const result = await reclaim(maxPages);
                pageResults.push(result);
                if (!patch) {
                  patch = patchSessionEntryCore(
                    target,
                    () => ({ label: "foreground writer progressed" }),
                    { skipMaintenance: true, preserveActivity: true },
                  ).then((entry) => {
                    pagesAtPatchCompletion = pageResults.length;
                    return entry;
                  });
                  void patch.catch(() => {});
                }
                return result;
              },
              ...context,
            ),
          );
        });
      try {
        await createHistoricalTranscript({
          ...historical,
          nextSessionId: "fairness-live",
          content: "Retained history survives physical page reclamation.",
          updatedAt: Date.now(),
        });
        const transcript = loadTranscriptEventsSync(historical);
        const owner = database();
        const pageSize = Number(owner.db.prepare("PRAGMA page_size").get()?.page_size);
        // sqlite-allow-raw -- Synthetic cache pages exercise real incremental vacuum without deleting history.
        owner.db
          .prepare(
            "INSERT INTO cache_entries(scope, key, blob, updated_at) VALUES (?, ?, zeroblob(?), 1)",
          )
          .run("writer-fairness", "free-pages", pageSize * 2048);
        owner.db.prepare("DELETE FROM cache_entries WHERE scope = ?").run("writer-fairness");
        owner.walMaintenance.checkpoint();
        const freePages = Number(owner.db.prepare("PRAGMA freelist_count").get()?.freelist_count);
        expect(freePages).toBeGreaterThan(1024);
        const before = await measureSessionPhysicalDiskUsage(storePath);
        const highWaterBytes = before.totalBytes - pageSize * 1024;

        maintenance = enforceSqliteSessionHistoryDiskBudget({
          storePath,
          mode: "enforce",
          maintenance: {
            maxDiskBytes: before.totalBytes - 1,
            highWaterBytes,
          },
        });
        const result = await maintenance;
        expect(patch).toBeDefined();
        await expect(patch).resolves.toMatchObject({
          sessionId: "fairness-live",
          label: "foreground writer progressed",
        });
        expect(result).toMatchObject({ removedEntries: 0, removedFiles: 0 });
        expect(result?.totalBytesAfter).toBeLessThanOrEqual(highWaterBytes);
        expect(loadSessionEntryReadOnly(target)).toMatchObject({
          sessionId: "fairness-live",
          label: "foreground writer progressed",
        });
        expect(loadTranscriptEventsSync(historical)).toEqual(transcript);
        expect(sessionExists("fairness-history")).toBe(true);
        expect(sessionExists("fairness-live")).toBe(true);
        expect(readArchiveNames("fairness-history")).toEqual([]);
        expect(pageResults.length).toBeGreaterThan(1);
        expect(pageResults[0]).toMatchObject({
          checkpointCompleted: true,
          vacuumPagesRequested: 8,
        });
        expect(pageResults[0]?.remainingFreePages).toBeGreaterThan(0);
        expect(pageResults.at(-1)?.remainingFreePages).toBe(0);
      } finally {
        await Promise.allSettled([maintenance, patch]);
        pages.mockRestore();
        temporaryRoot.mockRestore();
      }
    },
  );
  expect(fs.existsSync(fixtureRoot)).toBe(false);
  expect(pagesAtPatchCompletion).toBeGreaterThan(0);
  expect(pagesAtPatchCompletion).toBeLessThan(pageResults.length);
});
