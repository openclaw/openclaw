import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Compilable } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recordAcpParentStreamEventsForTest as recordAcpParentStreamEvents } from "../../agents/subagents/spawn/acp-parent-stream-store.sqlite.test-support.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { listUsageCountedTranscriptStats } from "../../infra/session-cost-usage-collection.test-support.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import {
  appendSqliteTrajectoryRuntimeEvents,
  createTrajectoryEvent,
} from "../../trajectory/runtime-store.test-support.js";
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
import { planSessionStateDeleteIfUnreferenced } from "./session-accessor.sqlite-delete-snapshot.js";
import {
  deleteMaterializedSessionStatePlans,
  readSessionGenerationIdsForKeys,
} from "./session-accessor.sqlite-lifecycle-state.js";
import { touchTranscriptMutationInTransaction } from "./session-accessor.sqlite-transcript-state.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.test-support.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";
import {
  waitForSessionTranscriptIndexReconcilesInStateDir,
  waitForSessionTranscriptProjection,
} from "./session-transcript-reconcile.js";
import { prepareTranscriptPayload } from "./transcript-payload.js";

type TestEvent = { id: string; [key: string]: unknown };
const event = (id: string, content = "archive me"): TestEvent => ({ type: "session", id, content });
const sha256 = (content: string | Uint8Array) => createHash("sha256").update(content).digest("hex");
const jsonl = (events: TestEvent[]) => `${events.map((row) => JSON.stringify(row)).join("\n")}\n`;

const trajectory = (sessionId: string) =>
  createTrajectoryEvent({ sessionId, type: "test.concurrent-delete" });

function expectArchive(archivePath: string | undefined, expected: TestEvent) {
  assert.ok(archivePath, "expected archive path");
  const lines = readSessionArchiveContentSync(archivePath).trim().split("\n");
  expect(lines).toEqual([JSON.stringify(expected)]);
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
  const entry = async (target: ReturnType<typeof scope>, updatedAt = Date.now()) =>
    replaceSessionEntry(target, { sessionId: target.sessionId, updatedAt });
  async function seed(sessionId: string, events = [event(sessionId)], withEntry = true) {
    const target = scope(sessionId);
    if (withEntry) {
      await entry(target);
    }
    await replaceTranscriptEvents(target, events);
    return target;
  }
  function database() {
    const target = resolveSqliteTargetFromSessionStorePath(storePath);
    assert.ok(target.path, "expected SQLite database path");
    return openOpenClawAgentDatabase({ agentId: target.agentId ?? "main", path: target.path });
  }
  function databaseQueries() {
    const db = database();
    const query = getNodeSqliteKysely<DB>(db.db);
    return {
      db,
      query,
      rows: <Row>(statement: Compilable<Row>) => executeSqliteQuerySync(db.db, statement).rows,
      archives: query.selectFrom("session_transcript_archives").selectAll(),
      write: (run: Parameters<typeof runOpenClawAgentWriteTransaction>[0]) =>
        runOpenClawAgentWriteTransaction(run, { agentId: db.agentId, path: db.path }),
    };
  }
  async function acp(target: ReturnType<typeof scope>, text: string, runId: string) {
    const db = database();
    await recordAcpParentStreamEvents({
      agentId: db.agentId,
      path: db.path,
      sessionId: target.sessionId,
      runId,
      events: [{ event: { type: "output", text }, createdAt: Date.now() }],
    });
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
    assert.ok(result, `expected archive plan for ${sessionId}`);
    return result;
  }
  function deletePlans(
    plans: Parameters<typeof deleteMaterializedSessionStatePlans>[1],
    sessionKey: string,
  ) {
    return databaseQueries().write((transaction) =>
      deleteMaterializedSessionStatePlans(transaction, plans, undefined, new Set([sessionKey])),
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
    expect(
      decodeSessionArchiveBytes(archive?.bytes ?? new Uint8Array(), archive?.encoding === "zstd"),
    ).toBe(jsonl(events));
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
      await entry(session, Date.now() + index);
      await replaceTranscriptEvents(session, [session.event]);
    }
    const retained = {
      ...scope("subagent:worker-byte-retained"),
      sessionId: "worker-byte-session-retained",
    };
    await entry(retained, Date.now() + sessions.length);
    const result = await applySessionEntryLifecycleMutation({
      storePath,
      maintenanceOverride: {
        maxEntries: 1,
        mode: "enforce",
        pruneAfterMs: Number.MAX_SAFE_INTEGER,
      },
    });
    const expected = { afterCount: 1, beforeCount: 3, capped: 2, modelRunPruned: 0, pruned: 0 };
    expect(result).toMatchObject(expected);
    expect(result.archivedTranscriptDirectories).toEqual([path.dirname(storePath)]);
    expect(loadSessionEntry(retained)).toBeDefined();
    const { archives, rows } = databaseQueries();
    const registered = rows(archives.orderBy("session_id"));
    expect(registered).toHaveLength(2);
    for (const session of sessions) {
      expect(loadSessionEntry(session)).toBeUndefined();
      await expect(loadTranscriptEvents(session)).resolves.toEqual([]);
      const archive = registered.find((row) => row.session_id === session.sessionId);
      expect(archive).toMatchObject({
        archive_sha256: expect.any(String),
        published_at: expect.any(Number),
      });
      const archivePath = path.join(path.dirname(storePath), archive?.archive_name ?? "");
      expect(sha256(fs.readFileSync(archivePath))).toBe(archive?.archive_sha256);
      expect(readSessionArchiveContentSync(archivePath)).toBe(jsonl([session.event]));
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
    expectArchive(archivePath, transcript);
    const bytes = fs.statSync(archivePath).size;
    for (const selector of [storePath, resolveSqliteTargetFromSessionStorePath(storePath).path]) {
      const usage = await measureSessionPhysicalDiskUsage(selector);
      const databaseBytes = fs.statSync(
        resolveSqliteTargetFromSessionStorePath(selector).path,
      ).size;
      expect(usage.totalBytes).toBe(databaseBytes + usage.databaseWalBytes + bytes);
    }
  });

  it("retains distinct transcript generations after a physical session id is restored", async () => {
    const sessionId = "restored-archive-session";
    const target = await seed(sessionId, [event(sessionId, "first generation")]);
    const generations = (keys = [target.sessionKey]) =>
      readSessionGenerationIdsForKeys(database(), keys);
    expect(generations([])).toEqual([]);
    expect(generations()).toEqual([sessionId]);
    const first = (await deletion(target.sessionKey)).archivedTranscripts[0];
    assert.ok(first, "expected first transcript archive");
    expect(generations()).toEqual([]);
    fs.rmSync(first.archivedPath);
    database()
      .db.prepare(
        "UPDATE session_transcript_archives SET published_at = NULL WHERE session_id = ? AND generation = ?",
      )
      .run(target.sessionId, first.generation);
    await entry(target, 2);
    await replaceTranscriptEvents(target, [event(target.sessionId, "second generation")]);
    expect(generations()).toEqual([sessionId]);
    const second = await deletion(target.sessionKey);
    expect(second.archivedTranscripts).toHaveLength(1);
    expect(second.archivedTranscripts[0]?.archivedPath).not.toBe(first.archivedPath);
    expectArchive(first.archivedPath, event(target.sessionId, "first generation"));
    expectArchive(
      second.archivedTranscripts[0]?.archivedPath,
      event(target.sessionId, "second generation"),
    );
    const { archives, rows } = databaseQueries();
    expect(rows(archives.where("session_id", "=", sessionId))).toHaveLength(2);
  });

  it("bounds oversized archive names and retries their pending export after deletion commits", async () => {
    const sessionId = `retry-committed-${"x".repeat(300)}`;
    const target = await seed(sessionId, [event(sessionId, "retry pending export")]);
    const first = await deletion(target.sessionKey);
    expect(first.deleted).toBe(true);
    expect(loadSessionEntry(target)).toBeUndefined();
    const archivePath = first.archivedTranscripts[0]?.archivedPath;
    assert.ok(archivePath, "expected published archive");
    expect(Buffer.byteLength(path.basename(archivePath), "utf8")).toBeLessThan(256);
    expect(path.basename(archivePath)).toMatch(/^session-[a-f0-9]{64}\.jsonl\.deleted\./);
    expectArchive(archivePath, event(sessionId, "retry pending export"));
    const { db, archives, rows } = databaseQueries();
    expect(rows(archives.where("archive_name", "=", path.basename(archivePath)))).toMatchObject([
      { session_id: sessionId, session_key: target.sessionKey },
    ]);
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
    const [persisted] = rows(archives.where("session_id", "=", sessionId));
    assert.ok(typeof persisted?.archive_name === "string", "expected republished archive name");
    expect(persisted).toMatchObject({
      archive_name: expect.stringMatching(/^session-[a-f0-9]{64}\.jsonl\.deleted\./),
      published_at: expect.any(Number),
    });
    expectArchive(
      path.join(path.dirname(storePath), persisted.archive_name),
      event(sessionId, "retry pending export"),
    );
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
      await entry(target);
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
    expectArchive(result.archivedTranscripts[0]?.archivedPath, event(ops.sessionId));
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
    "preserves events appended after a planned %s transcript snapshot",
    async (initial) => {
      const target = scope("changed-before-worker-snapshot");
      const original = event(target.sessionId, "original transcript");
      if (initial === "empty") {
        await entry(target);
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
      if (initial === "empty") {
        const materialized = await materializeSessionStateDeletePlans([planned]);
        expect(() => deletePlans(materialized, target.sessionKey)).toThrow(
          `SQLite session state changed before deletion for ${target.sessionId}`,
        );
      } else {
        await expect(materializeSessionStateDeletePlans([planned])).rejects.toThrow(
          `SQLite session state changed before archive materialization for ${target.sessionId}`,
        );
      }
      await expect(loadTranscriptEvents(target)).resolves.toEqual(events);
      const directory = path.dirname(storePath);
      const names = fs.existsSync(directory) ? fs.readdirSync(directory) : [];
      expect(names.filter((name) => name.startsWith(`${target.sessionId}.jsonl.deleted.`))).toEqual(
        [],
      );
    },
  );

  it.each([false, true])(
    "preserves lifecycle state on publication failure (capture=%s)",
    async (capture) => {
      const target = await seed("nested/archive-worker-lifecycle-failure", [
        {
          type: "message",
          id: "failure-message",
          message: {
            role: "user",
            content: [{ type: "text", text: "preserve every lifecycle row" }],
          },
        },
      ]);
      appendSqliteTrajectoryRuntimeEvents(target, [trajectory(target.sessionId)]);
      await acp(target, "preserve ACP state", "failure-run");
      const { query, rows } = databaseQueries();
      const tables = [
        "acp_parent_stream_events",
        "session_transcript_fts",
        "session_transcript_index_state",
        "transcript_rewrite_watermarks",
        "trajectory_runtime_events",
        "transcript_events",
        "session_windows",
      ] as const;
      const counts = () => [
        ...tables.map(
          (table) =>
            rows(
              query
                .selectFrom(table)
                .select(({ fn }) => fn.countAll<number>().as("count"))
                .where("session_id", "=", target.sessionId),
            )[0]?.count ?? 0,
        ),
        rows(
          query
            .selectFrom("session_nodes")
            .select("current_session_id")
            .where("current_session_id", "=", target.sessionId),
        ).length,
      ];
      await waitForSessionTranscriptProjection(target);
      const before = counts();
      if (capture) {
        expect(
          await applySessionEntryLifecycleMutation({
            captureArtifactCleanupError: true,
            removals: [{ archiveRemovedTranscript: true, sessionKey: target.sessionKey }],
            skipMaintenance: true,
            storePath,
          }),
        ).toMatchObject({ removedEntries: 0, artifactCleanupError: expect.any(Error) });
      } else {
        await expect(deletion(target.sessionKey)).rejects.toThrow(
          "Cannot archive SQLite transcript outside",
        );
      }
      expect(loadSessionEntry(target)).toMatchObject({ sessionId: target.sessionId });
      await expect(loadTranscriptEvents(target)).resolves.toHaveLength(1);
      expect(counts()).toEqual(before);
      expect(before).toEqual(Array(8).fill(1));
    },
  );

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
    const { query: sql, rows, write } = databaseQueries();
    const planned = plan(sessionId, kind !== "non-archive append");
    const { generation, sessionUpdatedAt, transcriptUpdatedAt } = planned.snapshot;
    expect([generation, sessionUpdatedAt, transcriptUpdatedAt]).not.toContain(null);
    const materialized = await materializeSessionStateDeletePlans([planned]);
    switch (kind) {
      case "rewrite generation":
        rows(
          sql
            .updateTable("transcript_rewrite_watermarks")
            .set({
              generation: `${generation ?? "missing"}-changed`,
              updated_at: Date.now(),
            })
            .where("session_id", "=", sessionId),
        );
        break;
      case "transcript mutation watermark":
      case "window metadata": {
        const update =
          kind === "transcript mutation watermark"
            ? { transcript_updated_at: (transcriptUpdatedAt ?? 0) + 1 }
            : { updated_at: (sessionUpdatedAt ?? 0) + 1 };
        rows(sql.updateTable("session_windows").set(update).where("session_id", "=", sessionId));
        break;
      }
      case "non-archive append":
        write((transaction) => {
          rows(
            sql.insertInto("transcript_events").values({
              session_id: sessionId,
              seq: 1,
              ...prepareTranscriptPayload(
                transaction.db,
                JSON.stringify(event("concurrent-event")),
              ),
              created_at: Date.now(),
            }),
          );
          touchTranscriptMutationInTransaction(transaction, sessionId);
        });
        break;
      case "trajectory":
        appendSqliteTrajectoryRuntimeEvents(target, [trajectory(sessionId)]);
        break;
      case "ACP parent-stream":
        await acp(target, "concurrent", "run-1");
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
    expect(
      rows(sql.selectFrom(table).select("seq").where("session_id", "=", sessionId)),
    ).toHaveLength(kind === "non-archive append" ? 2 : 1);
  });
});
