import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../../test/helpers/promise.js";
import { readChatHistoryPage } from "../../gateway/server-methods/chat-history-pages.js";
import { readChatHistoryMessageId } from "../../gateway/session-history-tail.js";
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
import { readSessionColdTranscript } from "./session-cold-storage-state.js";
import { runSessionColdStorageMaintenance } from "./session-cold-storage.js";
import {
  createSessionColdStorageFixture,
  historicalId,
  maintenanceConfig,
} from "./session-cold-storage.test-support.js";
import { createSessionHistoryBudgetFixture } from "./session-history-budget.test-support.js";
import { enforceSqliteSessionHistoryDiskBudget } from "./session-history-eviction.js";

it("admits a session patch and cross-store cold history between page-reclamation passes", async () => {
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
      const cold = await createSessionColdStorageFixture(
        state.statePath("cross-store-cold.sqlite"),
      );
      expect(
        await runSessionColdStorageMaintenance({ config: maintenanceConfig(cold.scope.storePath) }),
      ).toEqual({ archivedTranscripts: 1, externalizedTranscripts: 0 });
      expect(readSessionColdTranscript(cold.database(), historicalId)).toBeDefined();
      const firstPass = createDeferred();
      const resumePrune = createDeferred();
      let maintenance: ReturnType<typeof enforceSqliteSessionHistoryDiskBudget> | undefined;
      let patch: ReturnType<typeof patchSessionEntryCore> | undefined;
      let history: ReturnType<typeof readChatHistoryPage> | undefined;
      let pausedHistoryFailure: unknown;
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
                if (pageResults.length === 1) {
                  firstPass.resolve();
                  await resumePrune.promise;
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
        expect(fs.realpathSync(cold.scope.storePath)).not.toBe(fs.realpathSync(owner.path));
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
        void maintenance.catch(firstPass.reject);
        await withTestTimeout(firstPass.promise, 10_000, "The first real page unit did not settle");
        history = readChatHistoryPage({
          entry: undefined,
          provider: undefined,
          sessionId: historicalId,
          storePath: cold.scope.storePath,
          sessionAgentId: cold.scope.agentId,
          canonicalKey: cold.scope.sessionKey,
          max: 10,
          maxHistoryBytes: 100_000,
          effectiveMaxChars: 8000,
          offset: undefined,
          messageId: undefined,
        });
        try {
          await withTestTimeout(
            history,
            10_000,
            "Cold history waited for the paused archive sweep",
          );
        } catch (error) {
          pausedHistoryFailure = error;
        } finally {
          expect(pageResults).toHaveLength(1);
          resumePrune.resolve();
        }
        const page = await history;
        const result = await maintenance;
        expect(page.messages.map(readChatHistoryMessageId)).toEqual([
          "history-user",
          "history-assistant",
        ]);
        expect(readSessionColdTranscript(cold.database(), historicalId)).toBeUndefined();
        expect(cold.snapshot()).toEqual(cold.original);
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
        expect(pausedHistoryFailure).toBeUndefined();
      } finally {
        resumePrune.resolve();
        await Promise.allSettled([maintenance, patch, history]);
        pages.mockRestore();
        temporaryRoot.mockRestore();
      }
    },
  );
  expect(fs.existsSync(fixtureRoot)).toBe(false);
  expect(pagesAtPatchCompletion).toBeGreaterThan(0);
  expect(pagesAtPatchCompletion).toBeLessThan(pageResults.length);
});
