import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { expectBytesEqual } from "../../../test/helpers/file-snapshots.js";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import {
  prepareSystemAgentRunAdmission,
  resolveAdmittedRunActiveAssertion,
} from "../../agents/admitted-run-context.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import { withSqliteReaderOwner } from "../../infra/sqlite-reader-lifecycle.js";
import * as queue from "../../shared/store-writer-queue.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { replaceConfigFile } from "../config.js";
import * as diskBudget from "./disk-budget.js";
import { deleteSessionEntryLifecycle, resetSessionEntryLifecycle } from "./session-accessor.js";
import * as archivePublication from "./session-archive-publication.js";
import * as archivePruningOwner from "./session-history-archive-pruning.js";
import { installHistoryBudgetState } from "./session-history-budget-state.test-support.js";
import {
  createSessionHistoryBudgetFixture,
  joinSessionHistoryBudgetSweeps,
} from "./session-history-budget.test-support.js";
import { enforceSqliteSessionHistoryDiskBudget } from "./session-history-eviction.js";

const maintenance = { mode: "enforce" as const, maxDiskBytes: 1, highWaterBytes: 1 };

describe("SQLite post-commit history maintenance", () => {
  let testState: OpenClawTestState;
  let tempDir: string;
  let storePath: string;
  const { createHistoricalTranscript, database, sessionExists, readArchiveNames } =
    createSessionHistoryBudgetFixture(() => ({ storePath, tempDir }));

  installHistoryBudgetState("openclaw-session-history-budget-", (state, dir, store) => {
    testState = state;
    tempDir = dir;
    storePath = store;
  });

  const historical = (name: string, content: string, updatedAt = Date.now()) =>
    createHistoricalTranscript({
      sessionKey: `agent:main:${name}`,
      sessionId: `${name}-old`,
      nextSessionId: `${name}-live`,
      content,
      updatedAt,
    });
  const enforce = () =>
    enforceSqliteSessionHistoryDiskBudget({ storePath, mode: "enforce", maintenance });

  it
    .runIf(process.platform !== "win32")
    .for(["initial measurement", "publication writer"] as const)(
    "refuses a replaced physical store during %s",
    async (boundary, { signal }) => {
      const sessionId = "publication-source-old";
      await historical("publication-source", "archive the original physical generation", 1);
      const owner = database();
      const replacementPath = testState.statePath("publication-replacement.sqlite");
      const replacement = openOpenClawAgentDatabase({
        agentId: "main",
        path: replacementPath,
        env: testState.env,
      });
      replacement.db.exec(
        "CREATE TABLE successor_marker (value TEXT); INSERT INTO successor_marker VALUES ('untouched');",
      );
      await closeOpenClawAgentDatabaseByPathAsync(replacementPath);
      const replacementBytes = fs.readFileSync(replacementPath);
      owner.walMaintenance.checkpoint();
      if (boundary === "initial measurement") {
        // No retained native handle may independently refuse the replacement first.
        await closeOpenClawAgentDatabaseByPathAsync(owner.path);
      }
      const entered = createDeferred();
      const release = createDeferred();
      const publish = archivePublication.publishSessionStateArchivesInWorker;
      const pause = async <T>(value: T) => {
        entered.resolve();
        await release.promise;
        return value;
      };
      const measure = diskBudget.measureSessionPhysicalDiskUsage;
      const boundarySpy =
        boundary === "initial measurement"
          ? vi
              .spyOn(diskBudget, "measureSessionPhysicalDiskUsage")
              .mockImplementationOnce(async (pathname) => pause(await measure(pathname)))
          : vi
              .spyOn(archivePublication, "publishSessionStateArchivesInWorker")
              .mockImplementationOnce(async (params) => {
                await pause(undefined);
                return publish(params);
              });
      const sweep = enforce();
      const heldPath = `${owner.path}.held`;
      let replaced = false;
      try {
        await withinTest(
          awaitGateBeforeSettlement(entered.promise, sweep, `History skipped ${boundary}`),
          signal,
        );
        fs.renameSync(owner.path, heldPath);
        fs.renameSync(replacementPath, owner.path);
        replaced = true;
        release.resolve();
        await expect(sweep).rejects.toThrow(/file identity changed/);
        expectBytesEqual(fs.readFileSync(owner.path), replacementBytes, "successor database");
      } finally {
        release.resolve();
        await Promise.allSettled([sweep]);
        if (replaced) {
          fs.renameSync(owner.path, replacementPath);
          fs.renameSync(heldPath, owner.path);
        }
        boundarySpy.mockRestore();
      }
      expect(sessionExists(sessionId)).toBe(boundary === "initial measurement");
      expect(
        database()
          .db.prepare("SELECT published_at FROM session_transcript_archives WHERE session_id = ?")
          .get(sessionId),
      ).toEqual(boundary === "initial measurement" ? undefined : { published_at: null });
      expect(readArchiveNames(sessionId)).toEqual([]);
    },
  );

  it.each([
    ["delete", "closed", false, { live: true }],
    ["delete", "rollback", false, { live: true }],
    ["delete", "complete", true, { live: false }],
    ["delete", "partial", true, { live: true, old: false }],
    ["reset", "closed", false, { live: true }],
    ["reset", "post-commit failure", true, { live: false, next: true }],
  ] as const)(
    "defers post-commit maintenance until checkpoint recovery: %s / %s",
    async (operation, phase, committed, expectedSessions) => {
      const sessionKey = "agent:main:target";
      const queueSpy = vi.spyOn(queue, "runQueuedStoreWrite");
      for (const name of ["target", "unrelated"]) {
        await historical(name, "retained history".repeat(4096));
      }
      // Join setup's full sweep chain before pressure; only this lifecycle attempt may force it.
      await joinSessionHistoryBudgetSweeps(queueSpy);
      queueSpy.mockClear();
      const archive = path.join(tempDir, "retained.jsonl.deleted.2026-01-01T00-00-00.000Z");
      fs.writeFileSync(archive, Buffer.alloc(64 * 1024));
      await replaceConfigFile({
        nextConfig: { session: { maintenance } },
        afterWrite: { mode: "auto" },
      });
      const owner = database();
      const checkpoint = vi.spyOn(
        archivePruningOwner,
        "pruneAllSessionTranscriptArchivesToHighWater",
      );
      const admission = prepareSystemAgentRunAdmission({}, "maintenance-lifetime", "main", "setup");
      const assertActive = resolveAdmittedRunActiveAssertion(await admission.admit("embedded"))!;
      const target = { canonicalKey: sessionKey, storeKeys: [sessionKey] };
      if (phase === "rollback") {
        // sqlite-allow-raw -- a conflicting canonical row reaches the Worker's connection.
        owner.db
          .prepare(
            "INSERT INTO session_transcript_archives (session_id, generation, session_key, reason, encoding, archive_blob, archive_sha256, archive_name, created_at, published_at) SELECT session_id, generation, ?, 'deleted', 'identity', ?, ?, ?, 1, NULL FROM transcript_rewrite_watermarks WHERE session_id = 'target-old'",
          )
          .run(
            sessionKey,
            Buffer.from("conflict"),
            "0".repeat(64),
            "conflicting-target-old.jsonl.deleted",
          );
      }
      const reader = withSqliteReaderOwner(
        { operation: "fixture.session-history.lifecycle-reader", ownerKind: "main" },
        () => openNodeSqliteDatabase(owner.path, { readOnly: true }),
      );
      reader.exec("BEGIN");
      reader.prepare("SELECT count(*) FROM session_windows").get();
      const scoped = { storePath, target };
      try {
        if (phase === "closed") {
          admission.close();
        }
        const attempt =
          operation === "delete"
            ? deleteSessionEntryLifecycle({
                ...scoped,
                archiveTranscript: true,
                commitGuard: () => {
                  if (phase === "partial" && !sessionExists("target-old")) {
                    expect(readArchiveNames("target-old")).toHaveLength(1);
                    expect(checkpoint).not.toHaveBeenCalled();
                    admission.close();
                  }
                  assertActive();
                },
              })
            : resetSessionEntryLifecycle({
                ...scoped,
                buildNextEntry: () => {
                  assertActive();
                  // Keep the replacement live; age retention would protect its history windows.
                  return { sessionId: "target-next", updatedAt: Date.now() };
                },
                afterEntryMutation: () => {
                  expect(checkpoint).not.toHaveBeenCalled();
                  admission.close();
                  assertActive();
                },
              });
        if (phase === "complete") {
          await expect(attempt).resolves.toMatchObject({ deleted: true });
        } else {
          await expect(attempt).rejects.toThrow(
            phase === "rollback"
              ? "Conflicting SQLite transcript archive"
              : "authority is no longer active",
          );
        }
        if (phase === "rollback") {
          owner.db
            .prepare("DELETE FROM session_transcript_archives WHERE session_id = ?")
            .run("target-old");
        }
        const swept: Promise<unknown>[] = [];
        await joinSessionHistoryBudgetSweeps(queueSpy, swept);
        expect.soft(checkpoint.mock.calls.length > 0).toBe(committed);
        // Detailed checkpoint diagnostics and warning deduplication live in
        // session-history-wal-budget.test.ts; this suite owns lifecycle ordering.
        expect(await Promise.all(swept)).toEqual(
          committed
            ? [
                expect.objectContaining({
                  removedFiles: 0,
                  removedEntries: 0,
                  deferredReason: "checkpoint-incomplete",
                  checkpoint: expect.objectContaining({ state: "blocked" }),
                }),
              ]
            : [],
        );
        expect([fs.existsSync(archive), sessionExists("unrelated-old")]).toEqual([true, true]);
        if (phase === "complete") {
          // The requested deletion is committed even while unrelated pressure cleanup is deferred.
          expect([sessionExists("target-old"), sessionExists("target-live")]).toEqual([
            false,
            false,
          ]);
        }
        reader.exec("ROLLBACK");
        if (committed) {
          expect(database().walMaintenance.checkpoint()).toBe(true);
          const recovered = await enforce();
          expect(recovered?.deferredReason).toBeUndefined();
          expect(recovered?.removedEntries).toBeGreaterThan(0);
        }
        expect.soft(fs.existsSync(archive)).toBe(!committed);
        expect.soft(sessionExists("unrelated-old")).toBe(!committed);
        expect.soft(sessionExists("unrelated-live")).toBe(true);
        const actualSessions = Object.fromEntries(
          Object.keys(expectedSessions).map((id) => [id, sessionExists(`target-${id}`)]),
        );
        expect.soft(actualSessions).toEqual(expectedSessions);
      } finally {
        reader.close();
        admission.close();
      }
    },
  );
});
