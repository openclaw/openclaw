import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recordAcpParentStreamEvents } from "../../agents/subagents/spawn/acp-parent-stream-store.sqlite.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { listUsageCountedTranscriptStats } from "../../infra/session-cost-usage-collection.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { appendSqliteTrajectoryRuntimeEvents } from "../../trajectory/runtime-store.sqlite.js";
import type { TrajectoryEvent } from "../../trajectory/types.js";
import { decodeSessionArchiveBytes, readSessionArchiveContentSync } from "./archive-compression.js";
import { measureSessionPhysicalDiskUsage } from "./disk-budget.js";
import {
  applySessionEntryLifecycleMutation,
  deleteSessionEntryLifecycle,
  loadSessionEntry,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "./session-accessor.js";
import { writeTranscriptArchive } from "./session-accessor.sqlite-archive-artifact.js";
import { materializeSessionStateDeletePlans } from "./session-accessor.sqlite-archive.js";
import {
  deleteMaterializedSessionStatePlans,
  planSessionStateDeleteIfUnreferenced,
} from "./session-accessor.sqlite-lifecycle-state.js";
import { touchTranscriptMutationInTransaction } from "./session-accessor.sqlite-transcript-state.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";
import {
  waitForSessionTranscriptIndexReconcilesInStateDir,
  waitForSessionTranscriptProjection,
} from "./session-transcript-reconcile.js";

type TestEvent = { id: string; [key: string]: unknown };
const event = (id: string, content = "archive me"): TestEvent => ({ type: "session", id, content });
const sha256 = (content: string | Uint8Array) => createHash("sha256").update(content).digest("hex");

function trajectory(sessionId: string): TrajectoryEvent {
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

function archiveLines(archivePath: string | undefined) {
  expect(archivePath).toBeTruthy();
  return readSessionArchiveContentSync(archivePath ?? "")
    .trim()
    .split("\n");
}

describe("SQLite transcript archive worker", () => {
  let tempDir: string;
  let storePath: string;
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sqlite-archive-worker-"));
    storePath = path.join(tempDir, "agents", "main", "sessions", "sessions.json");
  });
  afterEach(async () => {
    // Workers must release native handles before Windows can remove the fixture.
    await waitForSessionTranscriptIndexReconcilesInStateDir(tempDir);
    await closeOpenClawAgentDatabasesAsync(tempDir);
    closeOpenClawAgentDatabasesForTest(tempDir);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const scope = (sessionId: string) => ({
    sessionId,
    sessionKey: `agent:main:${sessionId}`,
    storePath,
  });
  async function seed(sessionId: string, events = [event(sessionId)], withEntry = true) {
    const target = scope(sessionId);
    if (withEntry) {
      await replaceSessionEntry(target, { sessionId, updatedAt: Date.now() });
    }
    await replaceTranscriptEvents(target, events);
    return target;
  }
  function database() {
    const target = resolveSqliteTargetFromSessionStorePath(storePath);
    if (!target.path) {
      throw new Error("expected SQLite database path");
    }
    return openOpenClawAgentDatabase({ agentId: target.agentId ?? "main", path: target.path });
  }
  function deletion(sessionKey: string) {
    return deleteSessionEntryLifecycle({
      archiveTranscript: true,
      storePath,
      target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
    });
  }
  function plan(sessionId: string, archiveTranscript = true) {
    const result = planSessionStateDeleteIfUnreferenced({
      archiveDirectory: path.dirname(storePath),
      archiveTranscript,
      database: database(),
      referencedSessionIds: new Set(),
      sessionId,
    });
    if (!result) {
      throw new Error(`expected archive plan for ${sessionId}`);
    }
    return result;
  }
  function deletePlans(
    plans: Parameters<typeof deleteMaterializedSessionStatePlans>[1],
    sessionKey: string,
  ) {
    const db = database();
    return runOpenClawAgentWriteTransaction(
      (transaction) =>
        deleteMaterializedSessionStatePlans(transaction, plans, undefined, new Set([sessionKey])),
      { agentId: db.agentId, path: db.path },
    );
  }

  it("does not reuse lifecycle staging files as legacy archives", () => {
    const sessionId = "staging-reuse";
    const archiveDirectory = path.dirname(storePath);
    const content = `${JSON.stringify(event("reuse-event", "archive once"))}\n`;
    fs.mkdirSync(archiveDirectory, { recursive: true });
    const stagedPath = path.join(
      archiveDirectory,
      `${sessionId}.jsonl.deleted.2026-09-02T10-00-00.000Z.generation.jsonl-stage`,
    );
    fs.writeFileSync(stagedPath, content);
    const archivedPath = writeTranscriptArchive({
      archiveDirectory,
      content,
      reason: "deleted",
      sessionId,
    });
    expect(archivedPath).not.toBe(stagedPath);
    expect(fs.existsSync(stagedPath)).toBe(true);
    expect(readSessionArchiveContentSync(archivedPath)).toBe(content);
  });

  it("keeps the event loop responsive while a transcript archive is built", async () => {
    const sessionId = "off-main-archive-session";
    const events = Array.from({ length: 64 }, (_, index) =>
      event(
        `${sessionId}-${index}`,
        `${index === 0 ? "first: 你好\n" : index === 63 ? "last: 🦞\n" : `${index}:`}${randomBytes(576 * 1024).toString("base64")}`,
      ),
    );
    events.splice(
      1,
      0,
      ...Array.from({ length: 1_000 }, (_, index) =>
        event(`small-${index}`, `你好 🦞\n${"small row ".repeat(16)}`),
      ),
    );
    await seed(sessionId, events);
    let heartbeatCount = 0;
    const heartbeat = setInterval(() => {
      heartbeatCount += 1;
    }, 5);
    let materialized: Awaited<ReturnType<typeof materializeSessionStateDeletePlans>>;
    try {
      materialized = await materializeSessionStateDeletePlans([plan(sessionId)]);
    } finally {
      clearInterval(heartbeat);
    }
    expect(heartbeatCount).toBeGreaterThan(5);
    expect(materialized).toHaveLength(1);
    const archive = materialized[0]?.archive;
    expect(archive).toBeTruthy();
    expect(fs.existsSync(materialized[0]?.archivedTranscript?.archivedPath ?? "")).toBe(false);
    const expectedContent = `${events.map((row) => JSON.stringify(row)).join("\n")}\n`;
    const content = decodeSessionArchiveBytes(
      archive?.bytes ?? new Uint8Array(),
      archive?.encoding === "zstd",
    );
    expect(Buffer.byteLength(content)).toBe(Buffer.byteLength(expectedContent));
    expect(sha256(content)).toBe(sha256(expectedContent));
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(events.length);
    expect(lines.map((line) => JSON.parse(line))).toEqual(events);
  });

  it("caps private sessions across the archive byte limit without truncating their archives", async () => {
    const largeContent = "x".repeat(33 * 1024 * 1024);
    const sessions = [0, 1].map((index) => ({
      storePath,
      sessionKey: `agent:main:subagent:worker-byte-${index}`,
      sessionId: `worker-byte-session-${index}`,
      event: event(`worker-byte-session-${index}`, `${index}:${largeContent}`),
    }));
    for (const [index, session] of sessions.entries()) {
      await replaceSessionEntry(session, {
        sessionId: session.sessionId,
        updatedAt: Date.now() + index,
      });
      await replaceTranscriptEvents(session, [session.event]);
    }
    const retained = {
      ...scope("subagent:worker-byte-retained"),
      sessionId: "worker-byte-session-retained",
    };
    await replaceSessionEntry(retained, {
      sessionId: retained.sessionId,
      updatedAt: Date.now() + sessions.length,
    });
    const result = await applySessionEntryLifecycleMutation({
      storePath,
      maintenanceOverride: {
        maxEntries: 1,
        mode: "enforce",
        pruneAfterMs: Number.MAX_SAFE_INTEGER,
      },
    });
    expect(result).toMatchObject({
      afterCount: 1,
      beforeCount: 3,
      capped: 2,
      modelRunPruned: 0,
      pruned: 0,
    });
    expect(result.archivedTranscriptDirectories).toEqual([path.dirname(storePath)]);
    expect(loadSessionEntry(retained)).toBeDefined();
    const db = database();
    const archives = executeSqliteQuerySync(
      db.db,
      getNodeSqliteKysely<DB>(db.db)
        .selectFrom("session_transcript_archives")
        .select(["archive_name", "archive_sha256", "published_at", "session_id"])
        .orderBy("session_id"),
    ).rows;
    expect(archives).toHaveLength(2);
    for (const session of sessions) {
      expect(loadSessionEntry(session)).toBeUndefined();
      await expect(loadTranscriptEvents(session)).resolves.toEqual([]);
      const archive = archives.find((row) => row.session_id === session.sessionId);
      expect(archive).toMatchObject({
        archive_sha256: expect.any(String),
        published_at: expect.any(Number),
      });
      const archivePath = path.join(path.dirname(storePath), archive?.archive_name ?? "");
      expect(sha256(fs.readFileSync(archivePath))).toBe(archive?.archive_sha256);
      const content = readSessionArchiveContentSync(archivePath);
      const expected = `${JSON.stringify(session.event)}\n`;
      expect(Buffer.byteLength(content)).toBe(Buffer.byteLength(expected));
      expect(sha256(content)).toBe(sha256(expected));
    }
  });

  it("counts lifecycle archives for a custom store whose parent directory is named agent", async () => {
    storePath = path.join(tempDir, "backup", "agent", "sessions.json");
    const transcript = event("custom-directory-archive", "retain the custom-store transcript");
    const target = await seed(transcript.id, [transcript]);
    const result = await deletion(target.sessionKey);
    expect(result.deleted).toBe(true);
    const archivePath = result.archivedTranscripts[0]?.archivedPath ?? "";
    expect(fs.realpathSync.native(path.dirname(archivePath))).toBe(
      fs.realpathSync.native(path.join(tempDir, "backup", "sessions")),
    );
    expect(archiveLines(archivePath)).toEqual([JSON.stringify(transcript)]);
    const bytes = fs.statSync(archivePath).size;
    for (const selector of [storePath, resolveSqliteTargetFromSessionStorePath(storePath).path]) {
      const usage = await measureSessionPhysicalDiskUsage(selector);
      expect(usage.sessionFilesBytes).toBe(bytes);
      expect(usage.totalBytes).toBe(usage.databaseMainBytes + usage.databaseWalBytes + bytes);
    }
  });

  it("retains distinct transcript generations after a physical session id is restored", async () => {
    const target = await seed("restored-archive-session", [
      event("restored-archive-session", "first generation"),
    ]);
    const first = (await deletion(target.sessionKey)).archivedTranscripts[0];
    if (!first) {
      throw new Error("expected first transcript archive");
    }
    fs.rmSync(first.archivedPath);
    database()
      .db.prepare(
        "UPDATE session_transcript_archives SET published_at = NULL WHERE session_id = ? AND generation = ?",
      )
      .run(target.sessionId, first.generation);
    await replaceSessionEntry(target, { sessionId: target.sessionId, updatedAt: 2 });
    await replaceTranscriptEvents(target, [event(target.sessionId, "second generation")]);
    const second = await deletion(target.sessionKey);
    expect(second.archivedTranscripts).toHaveLength(1);
    expect(second.archivedTranscripts[0]?.archivedPath).not.toBe(first.archivedPath);
    expect(archiveLines(first.archivedPath)).toEqual([
      JSON.stringify(event(target.sessionId, "first generation")),
    ]);
    expect(archiveLines(second.archivedTranscripts[0]?.archivedPath)).toEqual([
      JSON.stringify(event(target.sessionId, "second generation")),
    ]);
    expect(
      database()
        .db.prepare(
          "SELECT generation FROM session_transcript_archives WHERE session_id = ? ORDER BY generation",
        )
        .all(target.sessionId),
    ).toHaveLength(2);
  });

  it("bounds oversized archive names and retries their pending export after deletion commits", async () => {
    const sessionId = `retry-committed-${"x".repeat(300)}`;
    const target = await seed(sessionId, [event(sessionId, "retry pending export")]);
    const first = await deletion(target.sessionKey);
    expect(first.deleted).toBe(true);
    expect(loadSessionEntry(target)).toBeUndefined();
    const archivePath = first.archivedTranscripts[0]?.archivedPath;
    if (!archivePath) {
      throw new Error("expected published archive");
    }
    expect(Buffer.byteLength(path.basename(archivePath), "utf8")).toBeLessThan(256);
    expect(path.basename(archivePath)).toMatch(/^session-[a-f0-9]{64}\.jsonl\.deleted\./);
    expect(archiveLines(archivePath)).toEqual([
      JSON.stringify(event(sessionId, "retry pending export")),
    ]);
    const db = database();
    expect(
      db.db
        .prepare(
          "SELECT session_id, session_key FROM session_transcript_archives WHERE archive_name = ?",
        )
        .get(path.basename(archivePath)),
    ).toEqual({ session_id: sessionId, session_key: target.sessionKey });
    await expect(listUsageCountedTranscriptStats("main", { storePath })).resolves.toEqual([
      expect.objectContaining({ sessionId }),
    ]);
    fs.rmSync(archivePath);
    const suffix = path.basename(archivePath).slice(path.basename(archivePath).indexOf("."));
    db.db
      .prepare(
        "UPDATE session_transcript_archives SET archive_name = ?, published_at = NULL WHERE session_id = ?",
      )
      .run(`${sessionId}${suffix}`, sessionId);
    await expect(deletion(target.sessionKey)).resolves.toMatchObject({
      archivedTranscripts: [],
      deleted: false,
    });
    const persisted = db.db
      .prepare(
        "SELECT archive_name, published_at FROM session_transcript_archives WHERE session_id = ?",
      )
      .get(sessionId);
    if (typeof persisted?.archive_name !== "string") {
      throw new Error("expected republished archive name");
    }
    expect(persisted).toMatchObject({
      archive_name: expect.stringMatching(/^session-[a-f0-9]{64}\.jsonl\.deleted\./),
      published_at: expect.any(Number),
    });
    expect(archiveLines(path.join(path.dirname(storePath), persisted.archive_name))).toEqual([
      JSON.stringify(event(sessionId, "retry pending export")),
    ]);
  });

  it("archives a logical agent transcript through the exact database's physical owner", async () => {
    storePath = path.join(tempDir, "shared.sqlite");
    const main = { ...scope("shared-main"), agentId: "main", defaultAgentId: "main" };
    const ops = {
      ...scope("shared-ops"),
      sessionKey: "agent:ops:shared-ops",
      agentId: "ops",
      defaultAgentId: "main",
    };
    for (const target of [main, ops]) {
      await replaceSessionEntry(target, { sessionId: target.sessionId, updatedAt: Date.now() });
      await replaceTranscriptEvents(target, [event(target.sessionId)]);
    }
    expect(resolveSqliteTargetFromSessionStorePath(storePath, ops)).toMatchObject({
      agentId: "main",
      path: storePath,
      shared: true,
    });
    expect(database().agentId).toBe("main");
    expect(database().agentId).not.toBe(ops.agentId);
    const result = await deleteSessionEntryLifecycle({
      agentId: ops.agentId,
      archiveTranscript: true,
      storePath,
      target: { canonicalKey: ops.sessionKey, storeKeys: [ops.sessionKey] },
    });
    expect(archiveLines(result.archivedTranscripts[0]?.archivedPath)).toEqual([
      JSON.stringify(event(ops.sessionId)),
    ]);
    await expect(loadTranscriptEvents(ops)).resolves.toEqual([]);
    await expect(loadTranscriptEvents(main)).resolves.toEqual([event(main.sessionId)]);
    expect(loadSessionEntry(main)).toMatchObject({ sessionId: main.sessionId });
  });

  it("rejects deduped plans with different transcript snapshots", async () => {
    const target = await seed("conflicting-plan-snapshots", undefined, false);
    const planned = plan(target.sessionId);
    const conflict = {
      ...planned,
      snapshot: {
        ...planned.snapshot,
        transcriptUpdatedAt: (planned.snapshot.transcriptUpdatedAt ?? 0) + 1,
      },
    };
    await expect(materializeSessionStateDeletePlans([planned, conflict])).rejects.toThrow(
      `Conflicting SQLite transcript archive plans for ${target.sessionId}`,
    );
  });

  it.each(["empty", "nonempty"] as const)(
    "rejects changes to a planned %s transcript before publishing an archive",
    async (initial) => {
      const target = scope("changed-before-worker-snapshot");
      const original = event(target.sessionId, "original transcript");
      if (initial === "empty") {
        await replaceSessionEntry(target, { sessionId: target.sessionId, updatedAt: Date.now() });
      } else {
        await replaceTranscriptEvents(target, [original]);
      }
      const planned = plan(target.sessionId);
      if (initial === "empty") {
        expect(planned.snapshot.lastSeq).toBeNull();
      }
      const appended = event("concurrent-event", "concurrent append");
      const events = initial === "empty" ? [appended] : [original, appended];
      await replaceTranscriptEvents(target, events);
      await expect(materializeSessionStateDeletePlans([planned])).rejects.toThrow(
        `SQLite session state changed before archive materialization for ${target.sessionId}`,
      );
      await expect(loadTranscriptEvents(target)).resolves.toEqual(events);
      const directory = path.dirname(storePath);
      const names = fs.existsSync(directory) ? fs.readdirSync(directory) : [];
      expect(names.filter((name) => name.startsWith(`${target.sessionId}.jsonl.deleted.`))).toEqual(
        [],
      );
    },
  );

  it("preserves all lifecycle state when the archive worker rejects publication", async () => {
    const target = await seed("nested/archive-worker-lifecycle-failure", [
      {
        type: "message",
        id: "failure-message",
        parentId: null,
        message: {
          role: "user",
          content: [{ type: "text", text: "preserve every lifecycle row" }],
        },
        timestamp: Date.now(),
      },
    ]);
    appendSqliteTrajectoryRuntimeEvents(target, [trajectory(target.sessionId)]);
    const db = database();
    recordAcpParentStreamEvents({
      agentId: db.agentId,
      path: db.path,
      sessionId: target.sessionId,
      runId: "failure-run",
      events: [{ event: { type: "output", text: "preserve ACP state" }, createdAt: Date.now() }],
    });
    const query = getNodeSqliteKysely<DB>(db.db);
    function count(
      table:
        | "acp_parent_stream_events"
        | "session_transcript_fts"
        | "session_transcript_index_state"
        | "transcript_rewrite_watermarks"
        | "trajectory_runtime_events"
        | "transcript_events"
        | "session_windows",
    ) {
      return (
        executeSqliteQuerySync(
          db.db,
          query
            .selectFrom(table)
            .select(({ fn }) => fn.countAll<number>().as("count"))
            .where("session_id", "=", target.sessionId),
        ).rows[0]?.count ?? 0
      );
    }
    const counts = () => ({
      acp: count("acp_parent_stream_events"),
      fts: count("session_transcript_fts"),
      indexState: count("session_transcript_index_state"),
      rewriteWatermarks: count("transcript_rewrite_watermarks"),
      trajectory: count("trajectory_runtime_events"),
      transcript: count("transcript_events"),
      windows: count("session_windows"),
      nodes: executeSqliteQuerySync(
        db.db,
        query
          .selectFrom("session_nodes")
          .select("current_session_id")
          .where("current_session_id", "=", target.sessionId),
      ).rows.length,
    });
    await waitForSessionTranscriptProjection(target);
    const before = counts();
    await expect(deletion(target.sessionKey)).rejects.toThrow(
      "Cannot archive SQLite transcript outside",
    );
    expect(loadSessionEntry(target)?.sessionId).toBe(target.sessionId);
    await expect(loadTranscriptEvents(target)).resolves.toHaveLength(1);
    expect(counts()).toEqual(before);
    expect(before).toEqual({
      acp: 1,
      fts: 1,
      indexState: 1,
      nodes: 1,
      rewriteWatermarks: 1,
      trajectory: 1,
      transcript: 1,
      windows: 1,
    });
  });

  it("captures archive materialization failure without deleting the requested entry", async () => {
    const target = await seed("nested/captured-archive-failure");
    const result = await applySessionEntryLifecycleMutation({
      captureArtifactCleanupError: true,
      removals: [{ archiveRemovedTranscript: true, sessionKey: target.sessionKey }],
      skipMaintenance: true,
      storePath,
    });
    expect(result.removedEntries).toBe(0);
    expect(result.artifactCleanupError).toBeInstanceOf(Error);
    expect(loadSessionEntry(target)).toMatchObject({ sessionId: target.sessionId });
    await expect(loadTranscriptEvents(target)).resolves.toHaveLength(1);
  });

  it.each([
    "rewrite generation",
    "transcript mutation watermark",
    "window metadata",
    "non-archive append",
    "trajectory",
    "ACP parent-stream",
  ] as const)("keeps rows when %s changes after deletion planning", async (kind) => {
    const target = await seed("stale-snapshot", undefined, false);
    const { sessionId, sessionKey } = target;
    const db = database();
    const query = getNodeSqliteKysely<DB>(db.db);
    const planned = plan(sessionId, kind !== "non-archive append");
    expect(planned.snapshot.generation).not.toBeNull();
    expect(planned.snapshot.sessionUpdatedAt).not.toBeNull();
    expect(planned.snapshot.transcriptUpdatedAt).not.toBeNull();
    const materialized = await materializeSessionStateDeletePlans([planned]);
    switch (kind) {
      case "rewrite generation":
        executeSqliteQuerySync(
          db.db,
          query
            .updateTable("transcript_rewrite_watermarks")
            .set({
              generation: `${planned.snapshot.generation ?? "missing"}-changed`,
              updated_at: Date.now(),
            })
            .where("session_id", "=", sessionId),
        );
        break;
      case "transcript mutation watermark":
      case "window metadata": {
        const update =
          kind === "transcript mutation watermark"
            ? { transcript_updated_at: (planned.snapshot.transcriptUpdatedAt ?? 0) + 1 }
            : { updated_at: (planned.snapshot.sessionUpdatedAt ?? 0) + 1 };
        executeSqliteQuerySync(
          db.db,
          query.updateTable("session_windows").set(update).where("session_id", "=", sessionId),
        );
        break;
      }
      case "non-archive append":
        runOpenClawAgentWriteTransaction(
          (transaction) => {
            executeSqliteQuerySync(
              transaction.db,
              getNodeSqliteKysely<DB>(transaction.db)
                .insertInto("transcript_events")
                .values({
                  session_id: sessionId,
                  seq: 1,
                  event_json: JSON.stringify(event("concurrent-event", "concurrent append")),
                  created_at: Date.now(),
                }),
            );
            touchTranscriptMutationInTransaction(transaction, sessionId);
          },
          { agentId: db.agentId, path: db.path },
        );
        break;
      case "trajectory":
        appendSqliteTrajectoryRuntimeEvents(target, [trajectory(sessionId)]);
        break;
      case "ACP parent-stream":
        recordAcpParentStreamEvents({
          agentId: db.agentId,
          path: db.path,
          sessionId,
          runId: "run-1",
          events: [{ event: { type: "output", text: "concurrent" }, createdAt: Date.now() }],
        });
        break;
    }
    expect(() => deletePlans(materialized, sessionKey)).toThrow(
      `SQLite session state changed before deletion for ${sessionId}`,
    );
    const table =
      kind === "trajectory"
        ? "trajectory_runtime_events"
        : kind === "ACP parent-stream"
          ? "acp_parent_stream_events"
          : "transcript_events";
    const rows = executeSqliteQuerySync(
      db.db,
      query.selectFrom(table).select("seq").where("session_id", "=", sessionId),
    ).rows;
    expect(rows).toHaveLength(kind === "non-archive append" ? 2 : 1);
  });
});
