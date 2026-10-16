import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
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
import * as diskBudgetModule from "./disk-budget.js";
import type { SqliteSessionArchivePruningDiagnostics } from "./session-accessor.sqlite-contract.js";
import { replaceSessionEntry } from "./session-accessor.sqlite-entry.js";
import { readActiveTranscriptEntryAnchor } from "./session-accessor.sqlite-transcript-anchor.js";
import { appendTranscriptMessage } from "./session-accessor.sqlite-transcript-write.js";
import { rewriteTranscriptMessageAtAnchor } from "./session-accessor.transcript.js";
import * as archivePruningDiagnostics from "./session-history-archive-pruning-diagnostics.js";
import { withSessionHistoryBudgetSweepsForTest } from "./session-history-budget.test-support.js";
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

it.each(["checkpointed", "newer-frames", "deleted-rows", "recovery-during-handoff"] as const)(
  "prunes archives after checkpoint recovery: %s",
  async (kind) => {
    const newerFrames = kind !== "checkpointed";
    const canonical = kind === "deleted-rows";
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
    let pendingRecovery: (() => void) | undefined;
    const observePruning = archivePruningDiagnostics.observeSessionArchivePruning;
    vi.spyOn(archivePruningDiagnostics, "observeSessionArchivePruning").mockImplementation(
      async <T>(...args: Parameters<typeof observePruning<T>>) => {
        const result = await observePruning(...args);
        if (args[0].checkpointIncomplete && pendingRecovery) {
          const recover = pendingRecovery;
          pendingRecovery = undefined;
          recover();
        }
        return result;
      },
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
        if (canonical) {
          database.db
            .prepare(`INSERT INTO session_transcript_archives
            (session_id,generation,session_key,reason,encoding,archive_blob,archive_sha256,archive_name,created_at,published_at)
            VALUES (?, 'generation', ?, 'deleted', 'identity', X'00', ?, ?, 1, 1)`)
            .run(
              `archive-${tick}`,
              `agent:main:archive-${tick}`,
              "0".repeat(64),
              path.basename(file),
            );
        }
        const before = await measureSessionPhysicalDiskUsage(storePath);
        const enforce = () =>
          enforceSqliteSessionHistoryDiskBudget({
            ...options,
            storePath,
            mode: "enforce",
            maintenance: {
              maxDiskBytes: before.totalBytes - 128 * 1024,
              highWaterBytes: before.totalBytes - 128 * 1024,
            },
          });
        if (newerFrames) {
          write.run(Buffer.from(`pending-${tick}`), tick);
          const recover = () => {
            reader.exec("ROLLBACK");
            expect(database.walMaintenance.checkpoint()).toBe(true);
            reader.exec("BEGIN");
            reader.prepare("SELECT blob FROM cache_entries WHERE scope='wal-proof'").get();
            write.run(Buffer.from(`newer-${tick}`), tick);
          };
          if (kind === "recovery-during-handoff") {
            pendingRecovery = recover;
          }
          await expect(enforce()).resolves.toMatchObject({
            deferredReason: "checkpoint-incomplete",
            removedFiles: 0,
            freedBytes: 0,
          });
          expect(fs.existsSync(file)).toBe(true);
          if (kind === "recovery-during-handoff") {
            expect(pendingRecovery).toBeUndefined();
          } else {
            recover();
          }
        }
        const result = await enforce();
        expect(result?.deferredReason).toBe(canonical ? "checkpoint-incomplete" : undefined);
        expect(result?.removedFiles).toBe(1);
        if (canonical) {
          const retry = await enforce();
          expect(retry).toMatchObject({
            removedFiles: 0,
            overBudget: false,
          });
          expect(retry?.deferredReason).toBeUndefined();
        } else {
          expect(result?.freedBytes).toBeGreaterThanOrEqual(256 * 1024);
        }
        expect(fs.existsSync(file)).toBe(false);
        expect(
          reader.prepare("SELECT blob FROM cache_entries WHERE scope='wal-proof'").get()?.blob,
        ).toEqual(new Uint8Array(Buffer.from(`${newerFrames ? "pending" : "committed"}-${tick}`)));
      }
      if (!canonical) {
        expect(warn).toHaveBeenCalledTimes(newerFrames ? 3 : 0);
        expect(info).toHaveBeenCalledTimes(3);
        expect(info).toHaveBeenLastCalledWith(
          "session history disk budget cleanup completed",
          expect.objectContaining({ removedFiles: 1, removedEntries: 0 }),
        );
      }
    } finally {
      reader.close();
    }
  },
);

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
        await expect(enforce()).resolves.toMatchObject({
          deferredReason: "checkpoint-incomplete",
          removedFiles: 0,
        });
      }
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
      if (kind === "iterator") {
        // Native autocheckpoints and other workers need not publish a host observation.
        database.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        expect(fs.statSync(`${database.path}-wal`).size).toBe(0);
        await withSessionHistoryBudgetSweepsForTest(async () => {
          kickSessionHistoryDiskBudgetMaintenance({
            ...options,
            storePath,
            force: true,
            now: Date.now() + 4 * 3600_000,
            maintenanceConfig: maintenance,
          });
        });
        expect((await measureSessionPhysicalDiskUsage(storePath)).totalBytes).toBeLessThanOrEqual(
          maintenance.highWaterBytes!,
        );
      }
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

it("retries retained WAL after a complete passive checkpoint and reader release on the budget cadence", async () => {
  state = await createOpenClawTestState({ layout: "state-only", scenario: "empty" });
  const options = { agentId: "main", env: state.env };
  const database = openOpenClawAgentDatabase(options);
  ensureSessionTranscriptArchiveSchema(database.db);
  database.db.exec("PRAGMA wal_autocheckpoint=0");
  expect(database.walMaintenance.checkpoint()).toBe(true);
  const storePath = path.join(state.sessionsDir(), "sessions.json");
  const payload = Buffer.alloc(512 * 1024, 65);
  database.db
    .prepare(
      "INSERT INTO cache_entries(scope,key,blob,updated_at) VALUES ('wal-proof','traffic',?,1)",
    )
    .run(payload);
  const reader = openNodeSqliteDatabase(database.path, { readOnly: true });
  reader.exec("BEGIN");
  expect(
    reader.prepare("SELECT blob FROM cache_entries WHERE scope='wal-proof'").get()?.blob,
  ).toEqual(new Uint8Array(payload));
  const diagnostics: SqliteSessionArchivePruningDiagnostics[] = [];
  const observePruning = archivePruningDiagnostics.observeSessionArchivePruning;
  vi.spyOn(archivePruningDiagnostics, "observeSessionArchivePruning").mockImplementation(
    async <T>(...args: Parameters<typeof observePruning<T>>) => {
      const result = await observePruning(...args);
      diagnostics.push(structuredClone(args[0]));
      return result;
    },
  );
  const maintenance = resolveMaintenanceConfigFromInput({
    mode: "enforce",
    maxDiskBytes: 1,
    highWaterBytes: 1,
  });
  const params = { ...options, storePath, mode: "enforce" as const, maintenance };
  try {
    await enforceSqliteSessionHistoryDiskBudget(params);
    await expect(enforceSqliteSessionHistoryDiskBudget(params)).resolves.toMatchObject({
      freedBytes: 0,
      removedEntries: 0,
      removedFiles: 0,
    });
    expect(diagnostics.at(-1)).toMatchObject({
      checkpointCalls: 2,
      checkpointIncomplete: 0,
      checkpoint: { state: "complete" },
    });
    expect(database.db.prepare("PRAGMA freelist_count").get()?.freelist_count).toBe(0);
    const before = await measureSessionPhysicalDiskUsage(storePath);
    expect(before.databaseWalBytes).toBeGreaterThan(0);
    reader.exec("ROLLBACK");
    expect((await measureSessionPhysicalDiskUsage(storePath)).databaseWalBytes).toBe(
      before.databaseWalBytes,
    );
    await expect(inspectSqliteSessionHistoryDiskBudget(params)).resolves.toMatchObject({
      wouldMutate: false,
    });
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    await withSessionHistoryBudgetSweepsForTest(async () => {
      kickSessionHistoryDiskBudgetMaintenance({
        ...options,
        storePath,
        maintenanceConfig: maintenance,
      });
    });
    expect((await measureSessionPhysicalDiskUsage(storePath)).databaseWalBytes).toBe(
      before.databaseWalBytes,
    );
    clock.mockReturnValue(now + 31 * 60_000);
    await withSessionHistoryBudgetSweepsForTest(async () => {
      kickSessionHistoryDiskBudgetMaintenance({
        ...options,
        storePath,
        maintenanceConfig: maintenance,
      });
    });
    const after = await measureSessionPhysicalDiskUsage(storePath);
    expect(after.databaseWalBytes).toBe(0);
    expect(after.totalBytes).toBeLessThan(before.totalBytes);
    expect(
      database.db.prepare("SELECT blob FROM cache_entries WHERE scope='wal-proof'").get()?.blob,
    ).toEqual(new Uint8Array(payload));
  } finally {
    reader.close();
  }
});

it("coalesces forced kicks during and after a sweep until the one-minute interval expires", async () => {
  state = await createOpenClawTestState({ layout: "state-only", scenario: "empty" });
  const tempDir = state.sessionsDir();
  const storePath = path.join(tempDir, "sessions.json");
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  const measurement = vi
    .spyOn(diskBudgetModule, "measureSessionPhysicalDiskUsage")
    .mockResolvedValue({
      databaseMainBytes: 0,
      databaseWalBytes: 0,
      sessionFilesBytes: 0,
      totalBytes: 0,
    });
  const maintenanceConfig = resolveMaintenanceConfigFromInput({
    mode: "enforce",
    maxDiskBytes: 1,
    highWaterBytes: 1,
  });
  const kick = (locator = storePath) =>
    kickSessionHistoryDiskBudgetMaintenance({
      storePath: locator,
      force: true,
      maintenanceConfig,
    });
  const settle = async () => {
    await enforceSqliteSessionHistoryDiskBudget({
      storePath,
      mode: "warn",
      maintenance: { maxDiskBytes: null, highWaterBytes: null },
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  };
  kick();
  for (let index = 0; index < 10; index++) {
    kick(path.join(path.dirname(tempDir), "agent", "openclaw-agent.sqlite"));
  }
  await settle();
  expect(measurement).toHaveBeenCalledOnce();

  clock.mockReturnValue(now + 59_999);
  kick(path.join(path.dirname(tempDir), "agent", "openclaw-agent.sqlite"));
  await settle();
  expect(measurement).toHaveBeenCalledOnce();

  clock.mockReturnValue(now + 60_000);
  kick();
  await settle();
  expect(measurement).toHaveBeenCalledTimes(2);
});

it("reclaims newly freed pages after rewriting a protected current transcript", async () => {
  state = await createOpenClawTestState({ layout: "state-only", scenario: "empty" });
  const storePath = path.join(state.sessionsDir(), "sessions.json");
  const scope = { storePath, sessionKey: "agent:main:locked-budget", sessionId: "locked-budget" };
  await withSessionHistoryBudgetSweepsForTest(async () => {
    await replaceSessionEntry(scope, {
      sessionId: scope.sessionId,
      updatedAt: 1,
      modelSelectionLocked: true,
    });
    await appendTranscriptMessage(scope, {
      eventId: "large-answer",
      message: { role: "assistant", content: randomBytes(512 * 1024).toString("hex") },
    });
  });
  const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
  expect(database.walMaintenance.checkpoint()).toBe(true);
  const maintenance = resolveMaintenanceConfigFromInput({
    mode: "enforce",
    maxDiskBytes: 1,
    highWaterBytes: 1,
  });
  const params = { storePath, mode: "enforce" as const, maintenance };
  await expect(enforceSqliteSessionHistoryDiskBudget(params)).resolves.toMatchObject({
    removedEntries: 0,
    removedFiles: 0,
  });
  // Settle any initial allocation; this pass records protected pressure with no work left.
  await expect(enforceSqliteSessionHistoryDiskBudget(params)).resolves.toMatchObject({
    freedBytes: 0,
  });
  const before = await measureSessionPhysicalDiskUsage(storePath);
  const anchor = readActiveTranscriptEntryAnchor({ ...scope, entryId: "large-answer" });
  assert(anchor);
  await expect(
    rewriteTranscriptMessageAtAnchor(anchor, () => ({
      role: "assistant",
      content: "short answer",
    })),
  ).resolves.toMatchObject({ message: { content: "short answer" } });
  expect(database.walMaintenance.checkpoint()).toBe(true);
  expect(
    Number(database.db.prepare("PRAGMA freelist_count").get()?.freelist_count),
  ).toBeGreaterThan(0);
  // Manual preview continues to report definite logical reclamation only.
  await expect(inspectSqliteSessionHistoryDiskBudget(params)).resolves.toMatchObject({
    wouldMutate: false,
  });
  const now = Date.now() + 31 * 60_000;
  vi.spyOn(Date, "now").mockReturnValue(now);
  await withSessionHistoryBudgetSweepsForTest(async () => {
    kickSessionHistoryDiskBudgetMaintenance({ storePath, maintenanceConfig: maintenance, now });
  });
  const after = await measureSessionPhysicalDiskUsage(storePath);
  expect(after.databaseMainBytes).toBeLessThan(before.databaseMainBytes);
  expect(database.db.prepare("PRAGMA freelist_count").get()?.freelist_count).toBe(0);
  expect(
    database.db
      .prepare("SELECT current_session_id FROM session_nodes WHERE session_key = ?")
      .get(scope.sessionKey),
  ).toEqual({ current_session_id: scope.sessionId });
});
