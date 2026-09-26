import assert from "node:assert/strict";
import { channel } from "node:diagnostics_channel";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
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
import { runExclusiveSqliteSessionWrite } from "./session-accessor.sqlite-scope.js";
import * as archivePruningDiagnostics from "./session-history-archive-pruning-diagnostics.js";
import {
  enforceSqliteSessionHistoryDiskBudget,
  inspectSqliteSessionHistoryDiskBudget,
  kickSessionHistoryDiskBudgetMaintenance,
} from "./session-history-eviction.js";
import { resolveMaintenanceConfigFromInput } from "./store-maintenance.js";

const warn = vi.hoisted(() => vi.fn());
const info = vi.hoisted(() => vi.fn());
vi.mock("../../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (name: string) => {
      const logger = actual.createSubsystemLogger(name);
      return name === "sessions/history-eviction" ? { ...logger, warn, info } : logger;
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

it("admits a queued foreground write before draining all vacuum batches", async () => {
  state = await createOpenClawTestState({
    prefix: "wal-budget-fairness-",
    layout: "state-only",
    scenario: "minimal",
  });
  const options = { agentId: "main", env: state.env };
  const database = openOpenClawAgentDatabase(options);
  database.db.exec(`CREATE TABLE vacuum_fairness_fixture (payload BLOB);
    INSERT INTO vacuum_fairness_fixture VALUES (zeroblob(262144));
    DROP TABLE vacuum_fairness_fixture;`);
  expect(database.walMaintenance.checkpoint()).toBe(true);
  const freePages = () =>
    Number(database.db.prepare("PRAGMA freelist_count").get()?.freelist_count);
  const before = freePages();
  expect(before).toBeGreaterThan(8);
  fs.mkdirSync(state.sessionsDir(), { recursive: true });
  const storePath = path.join(state.sessionsDir(), "sessions.json");
  const usage = await measureSessionPhysicalDiskUsage(storePath);
  const maintenance = resolveMaintenanceConfigFromInput({
    mode: "enforce",
    maxDiskBytes: usage.totalBytes - 1,
    highWaterBytes: usage.totalBytes - 1,
  });
  let foreground: Promise<void> | undefined;
  let observedFreePages = 0;
  const writes = channel("openclaw.session.write");
  const observe = (message: unknown) => {
    if (!foreground && isRecord(message) && message.operation === "session.history.free-pages") {
      foreground = runExclusiveSqliteSessionWrite(
        options,
        async () => {
          observedFreePages = freePages();
          database.db
            .prepare("INSERT INTO cache_entries(scope,key,blob,updated_at) VALUES (?,?,?,?)")
            .run("fairness", "foreground", Buffer.from("committed"), 1);
        },
        "session.entry-replacements",
      );
    }
  };
  writes.subscribe(observe);
  try {
    await enforceSqliteSessionHistoryDiskBudget({
      ...options,
      storePath,
      mode: "enforce",
      maintenance,
    });
    expect(foreground).toBeDefined();
    await foreground;
    expect(observedFreePages).toBeGreaterThan(0);
    expect(observedFreePages).toBeLessThan(before);
    expect(freePages()).toBe(0);
    expect(
      database.db.prepare("SELECT blob FROM cache_entries WHERE scope='fairness'").get()?.blob,
    ).toEqual(new Uint8Array(Buffer.from("committed")));
  } finally {
    writes.unsubscribe(observe);
    await foreground;
  }
});

it("prunes archives when readers prevent WAL truncation but all frames are checkpointed", async () => {
  state = await createOpenClawTestState({
    prefix: "wal-budget-checkpointed-",
    layout: "state-only",
    scenario: "minimal",
  });
  const options = { agentId: "main", env: state.env };
  const database = openOpenClawAgentDatabase(options);
  ensureSessionTranscriptArchiveSchema(database.db);
  database.db.exec("PRAGMA wal_autocheckpoint=0");
  fs.mkdirSync(state.sessionsDir(), { recursive: true });
  const storePath = path.join(state.sessionsDir(), "sessions.json");
  const reader = openNodeSqliteDatabase(database.path, { readOnly: true });
  const write = database.db.prepare(
    "INSERT OR REPLACE INTO cache_entries(scope,key,blob,updated_at) VALUES ('wal-proof','traffic',?,?)",
  );
  // Settle schema and initial allocation before measuring steady-state traffic.
  write.run(Buffer.from("committed-init"), -1);
  expect(database.walMaintenance.checkpoint()).toBe(true);
  warn.mockClear();
  info.mockClear();
  try {
    for (let tick = 0; tick < 3; tick++) {
      if (reader.isTransaction) {
        reader.exec("ROLLBACK");
      }
      write.run(Buffer.from(`committed-${tick}`), tick);
      reader.exec("BEGIN");
      reader.prepare("SELECT blob FROM cache_entries WHERE scope='wal-proof'").get();
      const file = path.join(
        state.sessionsDir(),
        `traffic-${tick}.jsonl.deleted.2020-01-01T00-00-00.000Z`,
      );
      fs.writeFileSync(file, Buffer.alloc(256 * 1024, tick));
      const before = await measureSessionPhysicalDiskUsage(storePath);
      const result = await enforceSqliteSessionHistoryDiskBudget({
        ...options,
        storePath,
        mode: "enforce",
        maintenance: {
          maxDiskBytes: before.totalBytes - 128 * 1024,
          highWaterBytes: before.totalBytes - 128 * 1024,
        },
      });
      expect(result?.deferredReason).toBeUndefined();
      expect(result?.removedFiles).toBe(1);
      expect(result?.freedBytes).toBeGreaterThanOrEqual(256 * 1024);
      expect(fs.existsSync(file)).toBe(false);
      expect(
        reader.prepare("SELECT blob FROM cache_entries WHERE scope='wal-proof'").get()?.blob,
      ).toEqual(new Uint8Array(Buffer.from(`committed-${tick}`)));
    }
    expect(warn).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledTimes(3);
    expect(info).toHaveBeenLastCalledWith(
      "session history disk budget cleanup completed",
      expect.objectContaining({ removedFiles: 1, removedEntries: 0 }),
    );
  } finally {
    reader.close();
  }
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
          checkpointCalls: 2,
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
