import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, expect, it, vi } from "vitest";
import { getNodeSqliteKysely, iterateSqliteQuerySync } from "../../infra/kysely-sync.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import {
  sqliteReaderDatabasePathKey,
  withSqliteReaderOwner,
} from "../../infra/sqlite-reader-lifecycle.js";
import {
  onSqliteWalCheckpoint,
  publishSqliteWalCheckpointObservation,
  type SqliteWalCheckpointSnapshot,
} from "../../infra/sqlite-wal-checkpoint.js";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { ensureSessionTranscriptArchiveSchema } from "../../state/openclaw-agent-session-transcript-archive-schema.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import {
  drainSessionDiskBudgetWorkers,
  measureSessionPhysicalDiskUsage,
} from "./disk-budget-runtime.js";
import type { SqliteSessionArchivePruningDiagnostics } from "./session-accessor.sqlite-contract.js";
import * as archivePruningDiagnostics from "./session-history-archive-pruning-diagnostics.js";
import {
  enforceSqliteSessionHistoryDiskBudget,
  inspectSqliteSessionHistoryDiskBudget,
  kickSessionHistoryDiskBudgetMaintenance,
} from "./session-history-eviction.js";
import { resolveMaintenanceConfigFromInput } from "./store-maintenance.js";

const warn = vi.hoisted(() => vi.fn());
vi.mock("../../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (name: string) => {
      const logger = actual.createSubsystemLogger(name);
      return name === "sessions/history-eviction" ? { ...logger, warn } : logger;
    },
  };
});

let state: OpenClawTestState;
afterEach(async () => {
  vi.restoreAllMocks();
  await drainSessionDiskBudgetWorkers();
  await closeOpenClawAgentDatabasesAsync();
  await state?.cleanup();
});

it.each(["transaction", "iterator"] as const)(
  "defers WAL-only pressure without deleting archives, names the %s, and resumes after checkpoint recovery",
  async (kind) => {
    state = await createOpenClawTestState({
      prefix: "wal-budget-",
      layout: "state-only",
      scenario: "minimal",
    });
    const options = { agentId: "main", env: state.env };
    const database = openOpenClawAgentDatabase(options);
    const databasePathKey = sqliteReaderDatabasePathKey(database.path);
    ensureSessionTranscriptArchiveSchema(database.db);
    database.db.exec("PRAGMA wal_autocheckpoint=0");
    const sessions = state.sessionsDir();
    fs.mkdirSync(sessions, { recursive: true });
    const storePath = path.join(sessions, "sessions.json");
    const insert = database.db.prepare(`INSERT INTO session_transcript_archives
      (session_id,generation,session_key,reason,encoding,archive_blob,archive_sha256,archive_name,created_at,published_at)
      VALUES (?, 'generation', ?, 'deleted', 'identity', ?, ?, ?, 1, 1)`);
    const files = Array.from({ length: 4 }, (_, index) => {
      const name = `wal-${index}.jsonl.deleted.2020-01-01T00-00-00.000Z`;
      const bytes = Buffer.alloc(256 * 1024, 65 + index);
      insert.run(`archive-${index}`, `agent:main:archive-${index}`, bytes, "0".repeat(64), name);
      fs.writeFileSync(path.join(sessions, name), bytes);
      return name;
    });
    const initialCheckpoints: SqliteWalCheckpointSnapshot[] = [];
    const stopObserving = onSqliteWalCheckpoint(({ databasePath, health, observedAtNs }) => {
      if (databasePath === databasePathKey) {
        initialCheckpoints.push({ health, observedAtNs });
      }
    });
    try {
      expect(database.walMaintenance.checkpoint()).toBe(true);
    } finally {
      stopObserving();
    }
    const previouslyCompleted = initialCheckpoints.at(-1);
    assert(previouslyCompleted);
    const initial = await measureSessionPhysicalDiskUsage(storePath);
    const maintenance = resolveMaintenanceConfigFromInput({
      mode: "enforce",
      maxDiskBytes: initial.totalBytes + 1024,
      highWaterBytes: initial.totalBytes,
    });
    const operation = `fixture.session-catalog.${kind}`;
    const reader = withSqliteReaderOwner({ operation, ownerKind: "main" }, () =>
      openNodeSqliteDatabase(database.path, { readOnly: true }),
    );
    let releaseIterator: (() => void) | undefined;
    withSqliteReaderOwner({ operation, ownerKind: "main" }, () => {
      if (kind === "transaction") {
        reader.exec("BEGIN");
        reader.prepare("SELECT count(*) FROM session_transcript_archives").get();
      } else {
        const iterator = iterateSqliteQuerySync(
          reader,
          getNodeSqliteKysely<{ session_transcript_archives: { session_id: string } }>(reader)
            .selectFrom("session_transcript_archives")
            .select("session_id"),
        );
        iterator.next();
        releaseIterator = () => {
          iterator.return?.();
        };
      }
    });
    const readerFacts =
      kind === "iterator"
        ? { activeReaders: expect.arrayContaining([expect.objectContaining({ operation, kind })]) }
        : {
            readerDiagnostics: expect.arrayContaining([
              expect.objectContaining({
                nativeStatements: "unobserved",
                connections: expect.arrayContaining([
                  expect.objectContaining({ operation, transactionOpen: true }),
                ]),
              }),
            ]),
          };
    const release = () => {
      releaseIterator?.();
      if (reader.isTransaction) {
        reader.exec("ROLLBACK");
      }
    };
    const diagnostics: SqliteSessionArchivePruningDiagnostics[] = [];
    const observePruning = archivePruningDiagnostics.observeSessionArchivePruning;
    vi.spyOn(archivePruningDiagnostics, "observeSessionArchivePruning").mockImplementation(
      async <T>(...args: Parameters<typeof observePruning<T>>) => {
        const [facts, run] = args;
        try {
          return await observePruning(facts, run);
        } finally {
          diagnostics.push(structuredClone(facts));
        }
      },
    );
    warn.mockClear();
    try {
      const write = database.db.prepare(
        "INSERT OR REPLACE INTO cache_entries(scope,key,blob,updated_at) VALUES ('wal-proof','traffic',?,?)",
      );
      for (let index = 0; index < 4; index++) {
        write.run(Buffer.alloc(512 * 1024, index), index);
      }
      const before = await measureSessionPhysicalDiskUsage(storePath);
      expect(before.totalBytes - before.databaseWalBytes).toBeLessThan(maintenance.maxDiskBytes!);
      const enforce = () =>
        enforceSqliteSessionHistoryDiskBudget({
          ...options,
          storePath,
          mode: "enforce",
          maintenance,
        });
      const blocked = await enforce();
      expect(blocked).toMatchObject({
        removedEntries: 0,
        removedFiles: 0,
        deferredReason: "checkpoint-incomplete",
        totalBytesBefore: before.totalBytes,
        totalBytesAfter: before.totalBytes,
        walBytesBefore: before.databaseWalBytes,
        walBytesAfter: before.databaseWalBytes,
        checkpoint: {
          state: "blocked",
          ...readerFacts,
        },
      });
      expect(diagnostics).toEqual([
        expect.objectContaining({
          completed: false,
          checkpointCalls: 1,
          checkpointIncomplete: 1,
          walBytesBefore: before.databaseWalBytes,
          walBytesAfter: before.databaseWalBytes,
        }),
      ]);
      assert(blocked?.checkpoint);
      // A delayed worker fact remains older even when its wall clock was ahead.
      publishSqliteWalCheckpointObservation(database.path, {
        ...previouslyCompleted,
        health: {
          ...previouslyCompleted.health,
          observedAtMs: blocked.checkpoint.observedAtMs + 3600_000,
          lastCompletedAtMs: blocked.checkpoint.observedAtMs + 3600_000,
        },
      });
      for (let hour = 1; hour <= 3; hour++) {
        kickSessionHistoryDiskBudgetMaintenance({
          ...options,
          storePath,
          force: true,
          now: Date.now() + hour * 3600_000,
          maintenanceConfig: maintenance,
        });
        await expect(enforce()).resolves.toMatchObject({
          deferredReason: "checkpoint-incomplete",
          removedFiles: 0,
        });
      }
      expect(diagnostics).toHaveLength(1);
      expect((await measureSessionPhysicalDiskUsage(storePath)).databaseWalBytes).toBe(
        before.databaseWalBytes,
      );
      expect(files.every((name) => fs.existsSync(path.join(sessions, name)))).toBe(true);
      expect(warn).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith(
        "session history disk budget deferred until a completed WAL checkpoint is observed",
        expect.objectContaining({
          reason: "checkpoint-incomplete",
          checkpoint: expect.objectContaining(readerFacts),
        }),
      );
      expect(
        await inspectSqliteSessionHistoryDiskBudget({
          ...options,
          storePath,
          mode: "enforce",
          maintenance,
        }),
      ).toMatchObject({
        wouldMutate: false,
        diskBudget: { deferredReason: "checkpoint-incomplete" },
      });
      release();
      // Release alone is not an observed successful checkpoint.
      await expect(enforce()).resolves.toMatchObject({ deferredReason: "checkpoint-incomplete" });
      const checkpointClock = vi
        .spyOn(Date, "now")
        .mockReturnValue(blocked.checkpoint.observedAtMs - 1);
      try {
        expect(database.walMaintenance.checkpoint()).toBe(true);
      } finally {
        checkpointClock.mockRestore();
      }
      expect(fs.statSync(`${database.path}-wal`).size).toBe(0);
      const recovered = await enforce();
      const lastPruning = diagnostics.at(-1);
      expect(
        recovered?.deferredReason,
        recovered?.deferredReason === undefined
          ? undefined
          : JSON.stringify(
              {
                blockedCheckpoint: blocked.checkpoint,
                hostCheckpoint: database.walMaintenance.health,
                now: Date.now(),
                realClock: performance.timeOrigin + performance.now(),
                dateNowMocked: vi.isMockFunction(Date.now),
                recovered,
                diagnosticsCount: diagnostics.length,
                lastArchivePruning: {
                  completed: lastPruning?.completed,
                  checkpointCalls: lastPruning?.checkpointCalls,
                  checkpointIncomplete: lastPruning?.checkpointIncomplete,
                  checkpoint: lastPruning?.checkpoint,
                  walBytesBefore: lastPruning?.walBytesBefore,
                  walBytesAfter: lastPruning?.walBytesAfter,
                },
              },
              // Checkpoint errors can contain paths; retain only the recorded health facts.
              (key, value) => (key === "error" ? undefined : value),
            ),
      ).toBeUndefined();
      expect(recovered?.totalBytesAfter).toBeLessThanOrEqual(maintenance.highWaterBytes!);
      expect(diagnostics.at(-1)).toMatchObject({
        completed: true,
        checkpointIncomplete: 0,
      });
      expect(() =>
        JSON.stringify({ blocked, recovered, diagnostics, health: database.walMaintenance.health }),
      ).not.toThrow();
    } finally {
      release();
      reader.close();
    }
  },
);
