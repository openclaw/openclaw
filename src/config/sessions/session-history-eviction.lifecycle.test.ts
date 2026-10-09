import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import {
  prepareSystemAgentRunAdmission,
  resolveAdmittedRunActiveAssertion,
} from "../../agents/admitted-run-context.js";
import { resetAgentRunRegistryForTest } from "../../infra/agent-run-registry.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import { withSqliteReaderOwner } from "../../infra/sqlite-reader-lifecycle.js";
import * as tmpDirOwner from "../../infra/tmp-openclaw-dir.js";
import * as queue from "../../shared/store-writer-queue.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  closeOpenClawAgentDatabaseByPathAsync,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { replaceConfigFile } from "../config.js";
import * as diskBudget from "./disk-budget.js";
import { deleteSessionEntryLifecycle, resetSessionEntryLifecycle } from "./session-accessor.js";
import * as sessionScope from "./session-accessor.sqlite-scope.js";
import * as archivePruningOwner from "./session-history-archive-pruning.js";
import {
  createSessionHistoryBudgetFixture,
  joinSessionHistoryBudgetSweeps,
} from "./session-history-budget.test-support.js";
import { enforceSqliteSessionHistoryDiskBudget } from "./session-history-eviction.js";

const evictionWarnSpy = vi.hoisted(() => vi.fn());
vi.mock("../../logging/subsystem.js", async () => {
  const actual = await vi.importActual<typeof import("../../logging/subsystem.js")>(
    "../../logging/subsystem.js",
  );
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) => {
      const logger = actual.createSubsystemLogger(subsystem);
      return subsystem === "sessions/history-eviction"
        ? { ...logger, warn: evictionWarnSpy }
        : logger;
    },
  };
});

describe("SQLite post-commit history maintenance", () => {
  let testState: OpenClawTestState;
  let tempDir: string;
  let storePath: string;
  const { createHistoricalTranscript, database, sessionExists, readArchiveNames } =
    createSessionHistoryBudgetFixture(() => ({ storePath, tempDir }));

  beforeEach(async () => {
    testState = await createOpenClawTestState({
      prefix: "openclaw-session-history-budget-",
      layout: "state-only",
    });
    vi.spyOn(tmpDirOwner, "resolvePreferredOpenClawTmpDir").mockReturnValue(testState.root);
    tempDir = testState.sessionsDir();
    fs.mkdirSync(tempDir, { recursive: true });
    storePath = path.join(tempDir, "sessions.json");
  });

  afterEach(async () => {
    resetAgentRunRegistryForTest();
    vi.restoreAllMocks();
    await enforceSqliteSessionHistoryDiskBudget({
      storePath,
      mode: "warn",
      maintenance: { maxDiskBytes: null, highWaterBytes: null },
    });
    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawAgentDatabasesForTest();
    await testState.cleanup();
  });

  it
    .runIf(process.platform !== "win32")
    .for(["initial measurement", "publication writer"] as const)(
    "refuses a replaced physical store during %s",
    async (boundary, { signal }) => {
      const sessionId = "publication-source-old";
      await createHistoricalTranscript({
        sessionKey: "agent:main:publication-source",
        sessionId,
        nextSessionId: "publication-source-live",
        content: "archive the original physical generation",
        updatedAt: 1,
      });
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
      const run = sessionScope.runExclusiveSqliteSessionWrite;
      let paused = false;
      const measure = diskBudget.measureSessionPhysicalDiskUsage;
      const measurement = vi
        .spyOn(diskBudget, "measureSessionPhysicalDiskUsage")
        .mockImplementation(async (pathname) => {
          const result = await measure(pathname);
          if (!paused && boundary === "initial measurement") {
            paused = true;
            entered.resolve();
            await release.promise;
          }
          return result;
        });
      const writer = vi
        .spyOn(sessionScope, "runExclusiveSqliteSessionWrite")
        .mockImplementation(<T>(...args: Parameters<typeof run<T>>) => {
          const [scope, operation, label, ...rest] = args;
          return run(
            scope,
            async () => {
              if (
                !paused &&
                boundary === "publication writer" &&
                label === "session.archive.publish-prepare"
              ) {
                paused = true;
                entered.resolve();
                await release.promise;
              }
              return operation();
            },
            label,
            ...rest,
          );
        });
      const sweep = enforceSqliteSessionHistoryDiskBudget({
        storePath,
        mode: "enforce",
        maintenance: { maxDiskBytes: 1, highWaterBytes: 1 },
      });
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
        expect(fs.readFileSync(owner.path)).toEqual(replacementBytes);
      } finally {
        release.resolve();
        await Promise.allSettled([sweep]);
        if (replaced) {
          fs.renameSync(owner.path, replacementPath);
          fs.renameSync(heldPath, owner.path);
        }
        writer.mockRestore();
        measurement.mockRestore();
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
    { operation: "delete", phase: "closed", committed: false },
    { operation: "delete", phase: "rollback", committed: false },
    { operation: "delete", phase: "complete", committed: true },
    { operation: "delete", phase: "partial", committed: true },
    { operation: "reset", phase: "closed", committed: false },
    { operation: "reset", phase: "post-commit failure", committed: true },
  ] as const)(
    "defers post-commit maintenance until checkpoint recovery: $operation / $phase",
    async ({ operation, phase, committed }) => {
      const sessionKey = "agent:main:target";
      const queueSpy = vi.spyOn(queue, "runQueuedStoreWrite");
      evictionWarnSpy.mockClear();
      for (const name of ["target", "unrelated"]) {
        await createHistoricalTranscript({
          sessionKey: `agent:main:${name}`,
          sessionId: `${name}-old`,
          nextSessionId: `${name}-live`,
          content: "retained history".repeat(4096),
          updatedAt: Date.now(),
        });
      }
      // Join setup's full sweep chain before pressure; only this lifecycle attempt may force it.
      await joinSessionHistoryBudgetSweeps(queueSpy);
      queueSpy.mockClear();
      const archive = path.join(tempDir, "retained.jsonl.deleted.2026-01-01T00-00-00.000Z");
      fs.writeFileSync(archive, Buffer.alloc(64 * 1024));
      await replaceConfigFile({
        nextConfig: {
          session: { maintenance: { mode: "enforce", maxDiskBytes: 1, highWaterBytes: 1 } },
        },
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
        const generation = owner.db
          .prepare("SELECT generation FROM transcript_rewrite_watermarks WHERE session_id = ?")
          .get("target-old") as { generation: string };
        // sqlite-allow-raw -- a conflicting canonical row reaches the Worker's connection.
        owner.db
          .prepare(
            `INSERT INTO session_transcript_archives (
               session_id, generation, session_key, reason, encoding, archive_blob,
               archive_sha256, archive_name, created_at, published_at
             ) VALUES (?, ?, ?, 'deleted', 'identity', ?, ?, ?, 1, NULL)`,
          )
          .run(
            "target-old",
            generation.generation,
            sessionKey,
            Buffer.from("conflict"),
            "0".repeat(64),
            "conflicting-target-old.jsonl.deleted",
          );
      }
      const readerOperation = "fixture.session-history.lifecycle-reader";
      const reader = withSqliteReaderOwner({ operation: readerOperation, ownerKind: "main" }, () =>
        openNodeSqliteDatabase(owner.path, { readOnly: true }),
      );
      reader.exec("BEGIN");
      reader.prepare("SELECT count(*) FROM session_windows").get();
      try {
        if (phase === "closed") {
          admission.close();
        }
        const attempt =
          operation === "delete"
            ? deleteSessionEntryLifecycle({
                storePath,
                target,
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
                storePath,
                target,
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
        const blockedCheckpoint = {
          state: "blocked",
          readerDiagnostics: expect.arrayContaining([
            expect.objectContaining({
              connections: expect.arrayContaining([
                expect.objectContaining({ operation: readerOperation, transactionOpen: true }),
              ]),
            }),
          ]),
        };
        expect(await Promise.all(swept)).toEqual(
          committed
            ? [
                expect.objectContaining({
                  deferredReason: "checkpoint-incomplete",
                  removedFiles: 0,
                  removedEntries: 0,
                  checkpoint: expect.objectContaining(blockedCheckpoint),
                }),
              ]
            : [],
        );
        expect(fs.existsSync(archive)).toBe(true);
        expect(sessionExists("unrelated-old")).toBe(true);
        if (committed) {
          await expect(checkpoint.mock.results[0]?.value).resolves.toMatchObject({
            completed: false,
            checkpointIncomplete: 1,
            checkpoint: blockedCheckpoint,
          });
          expect(evictionWarnSpy).toHaveBeenCalledWith(
            "session history disk budget deferred until a completed WAL checkpoint is observed",
            expect.objectContaining({
              reason: "checkpoint-incomplete",
              checkpoint: expect.objectContaining(blockedCheckpoint),
            }),
          );
        } else {
          expect(evictionWarnSpy).not.toHaveBeenCalled();
        }
        if (phase === "complete") {
          // The requested deletion is committed even while unrelated pressure cleanup is deferred.
          expect(sessionExists("target-old")).toBe(false);
          expect(sessionExists("target-live")).toBe(false);
        }
        reader.exec("ROLLBACK");
        if (committed) {
          expect(database().walMaintenance.checkpoint()).toBe(true);
          const recovered = await enforceSqliteSessionHistoryDiskBudget({
            storePath,
            mode: "enforce",
            maintenance: { maxDiskBytes: 1, highWaterBytes: 1 },
          });
          expect(recovered?.deferredReason).toBeUndefined();
          expect(recovered?.removedEntries).toBeGreaterThan(0);
        }
        expect.soft(fs.existsSync(archive)).toBe(!committed);
        expect.soft(sessionExists("unrelated-old")).toBe(!committed);
        expect.soft(sessionExists("unrelated-live")).toBe(true);
        expect
          .soft(sessionExists("target-live"))
          .toBe(phase !== "complete" && !(operation === "reset" && committed));
        if (phase === "partial") {
          expect.soft(sessionExists("target-old")).toBe(false);
        }
        if (operation === "reset" && committed) {
          expect.soft(sessionExists("target-next")).toBe(true);
        }
      } finally {
        reader.close();
        admission.close();
      }
    },
  );
});
