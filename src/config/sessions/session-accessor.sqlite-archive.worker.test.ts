// SQLite transcript archive worker tests cover off-main execution and snapshot fencing.
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordAcpParentStreamEvents } from "../../agents/acp-parent-stream-store.sqlite.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { appendSqliteTrajectoryRuntimeEvents } from "../../trajectory/runtime-store.sqlite.js";
import type { TrajectoryEvent } from "../../trajectory/types.js";
import { readSessionArchiveContentSync } from "./archive-compression.js";
import {
  deleteSessionEntryLifecycle,
  loadSessionEntry,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "./session-accessor.js";
import { materializeSqliteSessionStateDeletePlans } from "./session-accessor.sqlite-archive.js";
import { materializeSqliteTranscriptArchiveInWorker } from "./session-accessor.sqlite-archive.worker.js";
import {
  deleteMaterializedSqliteSessionStatePlans,
  planSqliteSessionStateDeleteIfUnreferenced,
} from "./session-accessor.sqlite-lifecycle-state.js";
import { touchTranscriptMutationInTransaction } from "./session-accessor.sqlite-transcript-state.js";
import { replaceSqliteTranscriptEvents } from "./session-accessor.sqlite.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";

type TestTranscriptEvent = Parameters<typeof replaceSqliteTranscriptEvents>[1][number];

describe("SQLite transcript archive worker", () => {
  let tempDir: string;
  let storePath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sqlite-archive-worker-"));
    storePath = path.join(tempDir, "agents", "main", "sessions", "sessions.json");
  });

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("keeps the event loop responsive while a transcript archive is built", async () => {
    const sessionId = "off-main-archive-session";
    await replaceSessionEntry(
      { sessionKey: "agent:main:off-main-archive", storePath },
      { sessionId, updatedAt: Date.now() },
    );
    await replaceSqliteTranscriptEvents(
      { sessionKey: "agent:main:off-main-archive", sessionId, storePath },
      Array.from({ length: 64 }, (_, index) =>
        createTranscriptEvent(
          `${sessionId}-${index}`,
          `${index}:${randomBytes(256 * 1024).toString("base64")}`,
        ),
      ),
    );

    let heartbeatTicks = 0;
    const heartbeat = setInterval(() => {
      heartbeatTicks += 1;
    }, 1);
    const deletion = deleteSessionEntryLifecycle({
      archiveTranscript: true,
      storePath,
      target: {
        canonicalKey: "agent:main:off-main-archive",
        storeKeys: ["agent:main:off-main-archive"],
      },
    });

    const result = await deletion.finally(async () => {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
      clearInterval(heartbeat);
    });
    expect(heartbeatTicks).toBeGreaterThan(5);
    expect(result.deleted).toBe(true);
    expect(result.archivedTranscripts).toHaveLength(1);
    expect(readArchiveLines(result.archivedTranscripts[0]?.archivedPath)).toHaveLength(64);
  });

  it("rejects transcript changes between deletion planning and the worker snapshot", async () => {
    const sessionId = "changed-before-worker-snapshot";
    const scope = {
      sessionKey: "agent:main:changed-before-worker-snapshot",
      sessionId,
      storePath,
    };
    const original = createTranscriptEvent(sessionId, "original transcript");
    await replaceSqliteTranscriptEvents(scope, [original]);
    const database = openLifecycleTestDatabase(storePath);
    const plan = planArchiveWorker(database, path.dirname(storePath), sessionId);

    await replaceSqliteTranscriptEvents(scope, [
      original,
      createTranscriptEvent("concurrent-event", "concurrent append"),
    ]);

    await expect(materializeSqliteSessionStateDeletePlans([plan])).rejects.toThrow(
      `SQLite session state changed before archive materialization for ${sessionId}`,
    );
    await expect(loadTranscriptEvents(scope)).resolves.toHaveLength(2);
    const archiveDirectory = path.dirname(storePath);
    const archiveNames = fs.existsSync(archiveDirectory) ? fs.readdirSync(archiveDirectory) : [];
    expect(archiveNames.filter((entry) => entry.startsWith(`${sessionId}.jsonl.deleted.`))).toEqual(
      [],
    );
  });

  it("rejects deduped plans with different transcript snapshots", async () => {
    const sessionId = "conflicting-plan-snapshots";
    await replaceSqliteTranscriptEvents(
      { sessionKey: "agent:main:conflicting-plan-snapshots", sessionId, storePath },
      [createTranscriptEvent(sessionId, "original transcript")],
    );
    const database = openLifecycleTestDatabase(storePath);
    const plan = planArchiveWorker(database, path.dirname(storePath), sessionId);
    const conflictingPlan = {
      ...plan,
      snapshot: {
        ...plan.snapshot,
        transcriptUpdatedAt: (plan.snapshot.transcriptUpdatedAt ?? 0) + 1,
      },
    };

    await expect(materializeSqliteSessionStateDeletePlans([plan, conflictingPlan])).rejects.toThrow(
      `Conflicting SQLite transcript archive plans for ${sessionId}`,
    );
  });

  it("rejects the first append after planning an empty transcript", async () => {
    const sessionId = "empty-then-appended-transcript";
    const scope = {
      sessionKey: "agent:main:empty-then-appended-transcript",
      sessionId,
      storePath,
    };
    await replaceSessionEntry(scope, { sessionId, updatedAt: Date.now() });
    const database = openLifecycleTestDatabase(storePath);
    const plan = planArchiveWorker(database, path.dirname(storePath), sessionId);
    expect(plan.snapshot.lastSeq).toBeNull();

    await replaceSqliteTranscriptEvents(scope, [
      createTranscriptEvent(sessionId, "first concurrent append"),
    ]);

    await expect(materializeSqliteSessionStateDeletePlans([plan])).rejects.toThrow(
      `SQLite session state changed before archive materialization for ${sessionId}`,
    );
    await expect(loadTranscriptEvents(scope)).resolves.toHaveLength(1);
  });

  it("propagates worker file failures without deleting transcript rows", async () => {
    const sessionId = "archive-file-failure-session";
    const scope = {
      sessionKey: "agent:main:archive-file-failure",
      sessionId,
      storePath,
    };
    await replaceSqliteTranscriptEvents(scope, [
      createTranscriptEvent(sessionId, "preserve after file failure"),
    ]);
    const blockedArchiveDirectory = path.join(tempDir, "archive-path-is-a-file");
    fs.writeFileSync(blockedArchiveDirectory, "not a directory", "utf8");
    const database = openLifecycleTestDatabase(storePath);
    const plan = planArchiveWorker(database, blockedArchiveDirectory, sessionId);

    await expect(materializeSqliteSessionStateDeletePlans([plan])).rejects.toThrow();
    await expect(loadTranscriptEvents(scope)).resolves.toHaveLength(1);
    expect(fs.readFileSync(blockedArchiveDirectory, "utf8")).toBe("not a directory");
  });

  it("keeps rows when a transcript changes after its archive snapshot", async () => {
    const sessionId = "stale-archive-snapshot-session";
    await replaceSqliteTranscriptEvents(
      { sessionKey: "agent:main:stale-archive-snapshot", sessionId, storePath },
      [createTranscriptEvent(sessionId, "archived snapshot")],
    );
    const database = openLifecycleTestDatabase(storePath);
    const db = getNodeSqliteKysely<OpenClawAgentKyselyDatabase>(database.db);
    executeSqliteQuerySync(
      database.db,
      db.deleteFrom("session_routes").where("session_id", "=", sessionId),
    );
    const plan = planSqliteSessionStateDeleteIfUnreferenced({
      archiveDirectory: path.dirname(storePath),
      database,
      referencedSessionIds: new Set(),
      sessionId,
    });
    if (!plan) {
      throw new Error("expected an unreferenced SQLite transcript delete plan");
    }
    const materialized = await materializeSqliteSessionStateDeletePlans([plan]);

    appendTranscriptEvent(database, sessionId);

    expect(() => deleteMaterializedPlans(database, materialized)).toThrow(
      `SQLite session state changed before deletion for ${sessionId}`,
    );
    expect(
      executeSqliteQuerySync(
        database.db,
        db.selectFrom("transcript_events").select("seq").where("session_id", "=", sessionId),
      ).rows,
    ).toHaveLength(2);
  });

  it("keeps rows when a non-archive delete plan becomes stale", async () => {
    const sessionId = "stale-non-archive-snapshot-session";
    await replaceSqliteTranscriptEvents(
      { sessionKey: "agent:main:stale-non-archive-snapshot", sessionId, storePath },
      [createTranscriptEvent(sessionId, "planned transcript")],
    );
    const database = openLifecycleTestDatabase(storePath);
    const db = getNodeSqliteKysely<OpenClawAgentKyselyDatabase>(database.db);
    executeSqliteQuerySync(
      database.db,
      db.deleteFrom("session_routes").where("session_id", "=", sessionId),
    );
    const plan = planSqliteSessionStateDeleteIfUnreferenced({
      archiveDirectory: path.dirname(storePath),
      archiveTranscript: false,
      database,
      referencedSessionIds: new Set(),
      sessionId,
    });
    if (!plan) {
      throw new Error("expected an unreferenced SQLite transcript delete plan");
    }
    const materialized = await materializeSqliteSessionStateDeletePlans([plan]);

    appendTranscriptEvent(database, sessionId);

    expect(() => deleteMaterializedPlans(database, materialized)).toThrow(
      `SQLite session state changed before deletion for ${sessionId}`,
    );
    expect(
      executeSqliteQuerySync(
        database.db,
        db.selectFrom("transcript_events").select("seq").where("session_id", "=", sessionId),
      ).rows,
    ).toHaveLength(2);
  });

  it.each(["trajectory", "ACP parent-stream"] as const)(
    "keeps rows when %s state changes after archive materialization",
    async (kind) => {
      const sessionId = `stale-${kind === "trajectory" ? "trajectory" : "acp"}-snapshot-session`;
      await replaceSqliteTranscriptEvents(
        { sessionKey: `agent:main:${sessionId}`, sessionId, storePath },
        [createTranscriptEvent(sessionId, "archived transcript")],
      );
      const database = openLifecycleTestDatabase(storePath);
      const db = getNodeSqliteKysely<OpenClawAgentKyselyDatabase>(database.db);
      executeSqliteQuerySync(
        database.db,
        db.deleteFrom("session_routes").where("session_id", "=", sessionId),
      );
      const plan = planArchiveWorker(database, path.dirname(storePath), sessionId);
      const materialized = await materializeSqliteSessionStateDeletePlans([plan]);

      if (kind === "trajectory") {
        appendSqliteTrajectoryRuntimeEvents({ sessionId, storePath }, [
          createTestTrajectoryEvent(sessionId),
        ]);
      } else {
        recordAcpParentStreamEvents({
          agentId: database.agentId,
          path: database.path,
          sessionId,
          runId: "run-1",
          events: [{ event: { type: "output", text: "concurrent" }, createdAt: Date.now() }],
        });
      }

      expect(() => deleteMaterializedPlans(database, materialized)).toThrow(
        `SQLite session state changed before deletion for ${sessionId}`,
      );
      const rows =
        kind === "trajectory"
          ? executeSqliteQuerySync(
              database.db,
              db
                .selectFrom("trajectory_runtime_events")
                .select("seq")
                .where("session_id", "=", sessionId),
            ).rows
          : executeSqliteQuerySync(
              database.db,
              db
                .selectFrom("acp_parent_stream_events")
                .select("seq")
                .where("session_id", "=", sessionId),
            ).rows;
      expect(rows).toHaveLength(1);
    },
  );

  it("falls back to an exclusive durable copy when hard links are unavailable", async () => {
    const sessionId = "copy-fallback-archive-session";
    await replaceSqliteTranscriptEvents(
      { sessionKey: "agent:main:copy-fallback-archive", sessionId, storePath },
      [createTranscriptEvent(sessionId, "copy fallback archive")],
    );

    const originalCopyFileSync = fs.copyFileSync;
    const openSpy = vi.spyOn(fs, "openSync");
    const fsyncSpy = vi.spyOn(fs, "fsyncSync");
    const copySpy = vi
      .spyOn(fs, "copyFileSync")
      .mockImplementation((...args) => originalCopyFileSync(...args));
    const linkSpy = vi.spyOn(fs, "linkSync").mockImplementation(() => {
      throw Object.assign(new Error("hard links are unavailable"), { code: "ENOTSUP" });
    });

    try {
      const database = openLifecycleTestDatabase(storePath);
      const workerResult = materializeSqliteTranscriptArchiveInWorker(
        planArchiveWorker(database, path.dirname(storePath), sessionId),
      );
      const archivedPath = workerResult.archivedPath;
      expect(archivedPath).not.toBeNull();
      expect(copySpy).toHaveBeenCalledWith(
        expect.stringContaining(`${sessionId}.jsonl.deleted.`),
        archivedPath,
        fs.constants.COPYFILE_EXCL,
      );
      const finalOpenIndex = openSpy.mock.calls.findIndex(
        (args) => args[0] === archivedPath && args[1] === "r+",
      );
      expect(finalOpenIndex).toBeGreaterThanOrEqual(0);
      expect(fsyncSpy).toHaveBeenCalledWith(openSpy.mock.results[finalOpenIndex]?.value);
      expect(readArchiveLines(archivedPath ?? undefined)).toEqual([
        createTranscriptEventLine(sessionId, "copy fallback archive"),
      ]);
    } finally {
      linkSpy.mockRestore();
      copySpy.mockRestore();
      fsyncSpy.mockRestore();
      openSpy.mockRestore();
    }
  });

  it("does not remove a concurrent archive when exclusive copy loses the race", async () => {
    const sessionId = "copy-race-owner-session";
    await replaceSqliteTranscriptEvents(
      { sessionKey: "agent:main:copy-race-owner", sessionId, storePath },
      [createTranscriptEvent(sessionId, "copy race owner")],
    );
    const database = openLifecycleTestDatabase(storePath);
    let winnerPath: string | undefined;
    const linkSpy = vi.spyOn(fs, "linkSync").mockImplementation(() => {
      throw Object.assign(new Error("hard links are unavailable"), { code: "ENOTSUP" });
    });
    const copySpy = vi.spyOn(fs, "copyFileSync").mockImplementation((_source, destination) => {
      winnerPath = String(destination);
      fs.writeFileSync(winnerPath, "concurrent winner", "utf8");
      throw Object.assign(new Error("exclusive copy lost the race"), { code: "EEXIST" });
    });

    try {
      expect(() =>
        materializeSqliteTranscriptArchiveInWorker(
          planArchiveWorker(database, path.dirname(storePath), sessionId),
        ),
      ).toThrow("Could not create SQLite transcript archive");
      expect(winnerPath).toBeDefined();
      expect(fs.readFileSync(winnerPath ?? "", "utf8")).toBe("concurrent winner");
    } finally {
      copySpy.mockRestore();
      linkSpy.mockRestore();
    }
  });

  it("does not reuse a matching in-flight temp file as an archive", async () => {
    const sessionId = "in-flight-temp-archive-session";
    const line = createTranscriptEventLine(sessionId, "in-flight temp archive");
    await replaceSqliteTranscriptEvents(
      { sessionKey: "agent:main:in-flight-temp-archive", sessionId, storePath },
      [JSON.parse(line) as TestTranscriptEvent],
    );
    const archiveDirectory = path.dirname(storePath);
    const tempPath = path.join(
      archiveDirectory,
      `${sessionId}.jsonl.deleted.2026-01-01T00-00-00.000Z.writer.tmp`,
    );
    fs.mkdirSync(archiveDirectory, { recursive: true });
    fs.writeFileSync(tempPath, `${line}\n`, "utf8");

    const database = openLifecycleTestDatabase(storePath);
    const result = materializeSqliteTranscriptArchiveInWorker(
      planArchiveWorker(database, archiveDirectory, sessionId),
    );

    expect(result.archivedPath).not.toBe(tempPath);
    expect(fs.existsSync(tempPath)).toBe(true);
    expect(readArchiveLines(result.archivedPath ?? undefined)).toEqual([line]);
  });

  it("reuses a matching archive before deleting entry rows", async () => {
    const sessionId = "duplicate-archive-session";
    const sessionKey = "agent:main:duplicate-archive";
    await replaceSessionEntry({ sessionKey, storePath }, { sessionId, updatedAt: Date.now() });
    await replaceSqliteTranscriptEvents({ sessionKey, sessionId, storePath }, [
      createTranscriptEvent(sessionId, "reuse archive"),
    ]);
    const archivePath = path.join(
      path.dirname(storePath),
      `${sessionId}.jsonl.deleted.2026-01-01T00-00-00.000Z`,
    );
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(
      archivePath,
      `${createTranscriptEventLine(sessionId, "reuse archive")}\n`,
      "utf-8",
    );

    const originalReaddirSync = fs.readdirSync;
    const entryObservedDuringDuplicateProbe: boolean[] = [];
    const readdirSpy = vi.spyOn(fs, "readdirSync").mockImplementation((...args) => {
      if (String(args[0]) === path.dirname(storePath)) {
        entryObservedDuringDuplicateProbe.push(
          loadSessionEntry({ sessionKey, storePath })?.sessionId === sessionId,
        );
      }
      return originalReaddirSync(...args);
    });

    try {
      const database = openLifecycleTestDatabase(storePath);
      const workerResult = materializeSqliteTranscriptArchiveInWorker(
        planArchiveWorker(database, path.dirname(storePath), sessionId),
      );
      expect(workerResult.archivedPath).toBe(archivePath);
      expect(entryObservedDuringDuplicateProbe).toEqual([true]);
    } finally {
      readdirSpy.mockRestore();
    }

    const result = await deleteSessionEntryLifecycle({
      archiveTranscript: true,
      storePath,
      target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
    });
    expect(result.deleted).toBe(true);
    expect(result.archivedTranscripts).toEqual([
      {
        archivedPath: archivePath,
        sourcePath: path.join(path.dirname(storePath), `${sessionId}.jsonl`),
      },
    ]);
  });
});

function createTranscriptEvent(sessionId: string, content: string): TestTranscriptEvent {
  return JSON.parse(createTranscriptEventLine(sessionId, content)) as TestTranscriptEvent;
}

function createTranscriptEventLine(sessionId: string, content: string): string {
  return JSON.stringify({ type: "session", id: sessionId, content });
}

function createTestTrajectoryEvent(sessionId: string): TrajectoryEvent {
  return {
    traceSchema: "openclaw-trajectory",
    schemaVersion: 1,
    traceId: sessionId,
    source: "runtime",
    type: "test.concurrent-delete",
    ts: "2026-07-22T00:00:00.000Z",
    seq: 1,
    sessionId,
  };
}

function readArchiveLines(archivePath: string | undefined): string[] {
  expect(archivePath).toBeTruthy();
  return readSessionArchiveContentSync(archivePath ?? "")
    .trim()
    .split("\n");
}

function openLifecycleTestDatabase(storePath: string) {
  const target = resolveSqliteTargetFromSessionStorePath(storePath);
  if (!target.path) {
    throw new Error(`Could not resolve SQLite database path for ${storePath}`);
  }
  return openOpenClawAgentDatabase({
    agentId: target.agentId ?? "main",
    path: target.path,
  });
}

function planArchiveWorker(
  database: ReturnType<typeof openLifecycleTestDatabase>,
  archiveDirectory: string,
  sessionId: string,
) {
  const plan = planSqliteSessionStateDeleteIfUnreferenced({
    archiveDirectory,
    database,
    referencedSessionIds: new Set(),
    sessionId,
  });
  if (!plan) {
    throw new Error(`expected an archive plan for ${sessionId}`);
  }
  return plan;
}

function appendTranscriptEvent(
  database: ReturnType<typeof openLifecycleTestDatabase>,
  sessionId: string,
): void {
  runOpenClawAgentWriteTransaction(
    (transactionDb) => {
      const db = getNodeSqliteKysely<OpenClawAgentKyselyDatabase>(transactionDb.db);
      executeSqliteQuerySync(
        transactionDb.db,
        db.insertInto("transcript_events").values({
          session_id: sessionId,
          seq: 1,
          event_json: createTranscriptEventLine("concurrent-event", "concurrent append"),
          created_at: Date.now(),
        }),
      );
      touchTranscriptMutationInTransaction(transactionDb, sessionId);
    },
    { agentId: database.agentId, path: database.path },
  );
}

function deleteMaterializedPlans(
  database: ReturnType<typeof openLifecycleTestDatabase>,
  plans: Parameters<typeof deleteMaterializedSqliteSessionStatePlans>[1],
): void {
  runOpenClawAgentWriteTransaction(
    (transactionDb) => deleteMaterializedSqliteSessionStatePlans(transactionDb, plans),
    { agentId: database.agentId, path: database.path },
  );
}
