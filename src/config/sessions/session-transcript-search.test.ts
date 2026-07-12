/** SQLite-native transcript search: in-transaction indexing, reconcile, and query bounds. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import type { TranscriptEvent } from "./session-accessor.js";
import {
  appendSqliteTranscriptEvent,
  appendSqliteTranscriptMessage,
  replaceSqliteTranscriptEvents,
} from "./session-accessor.sqlite.js";
import {
  extractTranscriptIndexEntry,
  listSessionsNeedingTranscriptIndexReconcile,
} from "./session-transcript-index.js";
import {
  resetSessionTranscriptSearchForTest,
  searchSessionTranscripts,
  sessionTranscriptSearchTesting,
  waitForSessionTranscriptReconcileActiveForTest,
  waitForSessionTranscriptReconcileForTest,
} from "./session-transcript-search.js";

vi.mock("../config.js", async () => ({
  ...(await vi.importActual<typeof import("../config.js")>("../config.js")),
  getRuntimeConfig: vi.fn().mockReturnValue({}),
}));

type TestPaths = { stateDir: string; tempDir: string };

let paths: TestPaths;

beforeEach(() => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-session-search-"));
  paths = {
    stateDir: path.join(tempDir, "state"),
    tempDir,
  };
});

function env(): NodeJS.ProcessEnv {
  return { ...process.env, OPENCLAW_STATE_DIR: paths.stateDir };
}

function transcriptScope(sessionId: string, sessionKey: string) {
  return {
    agentId: "main",
    env: env(),
    sessionId,
    sessionKey,
  };
}

async function appendUserMessage(sessionId: string, sessionKey: string, text: string) {
  await appendSqliteTranscriptMessage(transcriptScope(sessionId, sessionKey), {
    message: { role: "user", content: [{ type: "text", text }] },
  });
}

async function appendAssistantMessage(sessionId: string, sessionKey: string, text: string) {
  await appendSqliteTranscriptMessage(transcriptScope(sessionId, sessionKey), {
    message: { role: "assistant", content: [{ type: "text", text }] },
  });
}

function search(query: string, options: { limit?: number; sessionKeys?: string[] } = {}) {
  return searchSessionTranscripts({
    agentId: "main",
    env: env(),
    query,
    ...(options.limit !== undefined ? { limit: options.limit } : {}),
    ...(options.sessionKeys ? { sessionKeys: options.sessionKeys } : {}),
  });
}

async function waitForSearchReconcile(query: string): Promise<void> {
  await vi.waitFor(() => expect(search(query).indexing).toBe(false), {
    interval: 10,
    timeout: 5_000,
  });
}

afterEach(async () => {
  await waitForSearchReconcile("cleanup-probe");
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  fs.rmSync(paths.tempDir, { recursive: true, force: true });
});

function agentKysely() {
  const database = openOpenClawAgentDatabase({ agentId: "main", env: env() });
  return {
    db: database.db,
    kysely: getNodeSqliteKysely<
      Pick<
        OpenClawAgentKyselyDatabase,
        "session_transcript_fts" | "session_transcript_index_state" | "transcript_events"
      >
    >(database.db),
  };
}

async function finishReconcile(query: string) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await waitForSessionTranscriptReconcileForTest();
    const result = search(query);
    if (!result.indexing) {
      return result;
    }
  }
  throw new Error("transcript index did not converge");
}

describe("searchSessionTranscripts", () => {
  it("indexes appended messages synchronously and returns bounded hits", async () => {
    await appendUserMessage("session-1", "agent:main:main", "the deployment failed on friday");
    await appendAssistantMessage("session-1", "agent:main:main", "the deployment fix is rolling");

    const result = search("deployment");
    expect(result.indexing).toBe(false);
    expect(result.truncated).toBe(false);
    expect(result.hits).toHaveLength(2);
    const roles = result.hits.map((hit) => hit.role).toSorted();
    expect(roles).toEqual(["assistant", "user"]);
    for (const hit of result.hits) {
      expect(hit.sessionKey).toBe("agent:main:main");
      expect(hit.sessionId).toBe("session-1");
      expect(hit.snippet).toContain("deployment");
      expect(hit.messageId).toBeTruthy();
    }
  });

  it("ignores non-message events and misses non-matching queries", async () => {
    await appendUserMessage("session-1", "agent:main:main", "alpha topic");
    await appendSqliteTranscriptEvent(transcriptScope("session-1", "agent:main:main"), {
      type: "model_change",
      id: "model-change-1",
      model: "sonnet-4.6",
    } as unknown as TranscriptEvent);

    expect(search("sonnet").hits).toHaveLength(0);
    expect(search("alpha").hits).toHaveLength(1);
  });

  it("filters hits to the requested session keys", async () => {
    await appendUserMessage("session-1", "agent:main:main", "shared keyword payload");
    await appendUserMessage("session-2", "agent:main:other", "shared keyword payload");

    const all = search("keyword");
    expect(all.hits).toHaveLength(2);

    const filtered = search("keyword", { sessionKeys: ["agent:main:other"] });
    expect(filtered.hits).toHaveLength(1);
    expect(filtered.hits[0]?.sessionKey).toBe("agent:main:other");
    expect(filtered.hits[0]?.sessionId).toBe("session-2");
  });

  it("caps hits at the limit and reports truncation", async () => {
    for (let index = 0; index < 4; index += 1) {
      await appendUserMessage("session-1", "agent:main:main", `needle number ${index}`);
    }
    const result = search("needle", { limit: 3 });
    expect(result.hits).toHaveLength(3);
    expect(result.truncated).toBe(true);
  });

  it("rejects empty and oversized queries", () => {
    expect(() => search("   ")).toThrow(/query must not be empty/);
    expect(() => search("x".repeat(4097))).toThrow(/must not exceed/);
  });

  it("reindexes synchronously when a linear transcript is replaced", async () => {
    await appendUserMessage("session-1", "agent:main:main", "obsolete branch text");
    await replaceSqliteTranscriptEvents(transcriptScope("session-1", "agent:main:main"), [
      {
        type: "message",
        id: "m-new",
        parentId: null,
        message: { role: "user", content: [{ type: "text", text: "replacement text" }] },
        timestamp: 1720000000000,
      } as unknown as TranscriptEvent,
    ]);

    expect(search("obsolete").hits).toHaveLength(0);
    const result = search("replacement");
    expect(result.indexing).toBe(false);
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.messageId).toBe("m-new");
  });

  it("only surfaces the active branch after a leaf-control rewind", async () => {
    const scope = transcriptScope("session-1", "agent:main:main");
    await replaceSqliteTranscriptEvents(scope, [
      {
        type: "message",
        id: "m1",
        parentId: null,
        message: { role: "user", content: [{ type: "text", text: "alpha origin" }] },
      },
      {
        type: "message",
        id: "m2",
        parentId: "m1",
        message: { role: "assistant", content: [{ type: "text", text: "beta abandoned" }] },
      },
    ] as unknown as TranscriptEvent[]);
    await appendSqliteTranscriptEvent(scope, {
      type: "leaf",
      id: "leaf-1",
      parentId: "m2",
      targetId: "m1",
    } as unknown as TranscriptEvent);

    const dirty = search("beta");
    expect(dirty.indexing).toBe(true);
    expect(dirty.hits).toHaveLength(0);
    await waitForSearchReconcile("beta");

    expect(search("beta").hits).toHaveLength(0);
    expect(search("alpha").hits).toHaveLength(1);
  });

  it("backfills transcripts that predate the index via reconcile", async () => {
    await appendUserMessage("session-1", "agent:main:main", "historic knowledge");
    const { db, kysely } = agentKysely();
    executeSqliteQuerySync(db, kysely.deleteFrom("session_transcript_fts"));
    executeSqliteQuerySync(db, kysely.deleteFrom("session_transcript_index_state"));
    expect(search("historic").indexing).toBe(true);

    await waitForSearchReconcile("historic");
    const result = search("historic");
    expect(result.indexing).toBe(false);
    expect(result.hits).toHaveLength(1);
  });

  it("returns before a dirty rebuild and keeps the event loop responsive", async () => {
    const events = Array.from({ length: 512 }, (_, index) => ({
      type: "message",
      id: `m-${index}`,
      parentId: index === 0 ? null : `m-${index - 1}`,
      message: { role: "user", content: [{ type: "text", text: `responsive needle ${index}` }] },
    })) as unknown as TranscriptEvent[];
    await replaceSqliteTranscriptEvents(transcriptScope("session-1", "agent:main:main"), events);
    const { db, kysely } = agentKysely();
    executeSqliteQuerySync(db, kysely.deleteFrom("session_transcript_fts"));
    executeSqliteQuerySync(db, kysely.deleteFrom("session_transcript_index_state"));

    const dirty = search("needle");
    expect(dirty).toMatchObject({ hits: [], indexing: true });
    await waitForSessionTranscriptReconcileActiveForTest();
    let heartbeats = 0;
    const heartbeat = setInterval(() => {
      heartbeats += 1;
    }, 0);
    const result = await finishReconcile("needle");
    clearInterval(heartbeat);
    expect(heartbeats).toBeGreaterThan(1);
    expect(result.hits).toHaveLength(10);
  });

  it("serializes concurrent worker claims without duplicate FTS rows", async () => {
    const events = Array.from({ length: 192 }, (_, index) => ({
      type: "message",
      id: `claim-${index}`,
      parentId: index === 0 ? null : `claim-${index - 1}`,
      message: { role: "user", content: [{ type: "text", text: `claim payload ${index}` }] },
    })) as unknown as TranscriptEvent[];
    await replaceSqliteTranscriptEvents(transcriptScope("session-1", "agent:main:main"), events);
    const { db, kysely } = agentKysely();
    executeSqliteQuerySync(db, kysely.deleteFrom("session_transcript_fts"));
    executeSqliteQuerySync(db, kysely.deleteFrom("session_transcript_index_state"));

    await Promise.all([
      sessionTranscriptSearchTesting.runReconcileWorker({
        agentId: "main",
        stateDir: paths.stateDir,
      }),
      sessionTranscriptSearchTesting.runReconcileWorker({
        agentId: "main",
        stateDir: paths.stateDir,
      }),
    ]);

    const rows = executeSqliteQuerySync(
      db,
      kysely.selectFrom("session_transcript_fts").select("message_id"),
    ).rows;
    expect(new Set(rows.map((row) => row.message_id)).size).toBe(192);
    expect(rows).toHaveLength(192);
    expect(search("claim").indexing).toBe(false);
  });

  it("reclaims an abandoned worker generation after its lease expires", async () => {
    await appendUserMessage("session-1", "agent:main:main", "abandoned claim payload");
    const { db, kysely } = agentKysely();
    executeSqliteQuerySync(db, kysely.deleteFrom("session_transcript_fts"));
    executeSqliteQuerySync(
      db,
      kysely
        .updateTable("session_transcript_index_state")
        .set({ needs_rebuild: 42, updated_at: 1 })
        .where("session_id", "=", "session-1"),
    );

    await sessionTranscriptSearchTesting.runReconcileWorker({
      agentId: "main",
      stateDir: paths.stateDir,
    });

    expect(search("abandoned")).toMatchObject({ indexing: false });
    expect(search("abandoned").hits).toHaveLength(1);
  });

  it("does not hold a write lock while scanning a large unrelated FTS corpus", async () => {
    await appendUserMessage("session-1", "agent:main:main", "target dirty");
    const { db, kysely } = agentKysely();
    executeSqliteQuerySync(db, kysely.deleteFrom("session_transcript_index_state"));
    const insert = db.prepare(
      /* sqlite-allow-raw: focused FTS lock-latency fixture */
      "INSERT INTO session_transcript_fts(text, session_id, message_id, role, timestamp) VALUES (?, ?, ?, 'user', 1)",
    );
    for (let index = 0; index < 10_000; index += 1) {
      insert.run("unrelated", "unrelated-session", `unrelated-${index}`);
    }

    expect(search("target").indexing).toBe(true);
    await waitForSessionTranscriptReconcileActiveForTest();
    const append = appendUserMessage(
      "session-1",
      "agent:main:main",
      "append stays responsive",
    ).then(() => "append" as const);
    const reconcile = waitForSessionTranscriptReconcileForTest().then(() => "reconcile" as const);
    expect(await Promise.race([append, reconcile])).toBe("append");
    await reconcile;
  });

  it("resolves source and dist worker URLs and times out a silent worker", async () => {
    expect(
      sessionTranscriptSearchTesting.resolveReconcileWorkerUrl(
        "file:///repo/src/config/sessions/session-transcript-search.ts",
      ).pathname,
    ).toBe("/repo/src/config/sessions/session-transcript-reconcile.worker.ts");
    expect(
      sessionTranscriptSearchTesting.resolveReconcileWorkerUrl(
        "file:///repo/dist/chunks/session-transcript-search-ABC123.js",
      ).pathname,
    ).toBe("/repo/dist/config/sessions/session-transcript-reconcile.worker.js");
    await expect(
      sessionTranscriptSearchTesting.runReconcileWorker({
        agentId: "main",
        stateDir: paths.stateDir,
        timeoutMs: 25,
        workerUrl: new URL("data:text/javascript,setInterval(() => {}, 1000)"),
      }),
    ).rejects.toThrow(/timed out/);
    await expect(
      sessionTranscriptSearchTesting.runReconcileWorker({
        agentId: "main",
        stateDir: paths.stateDir,
        planningTimeoutMs: 25,
        workerUrl: new URL(
          "data:text/javascript,import { parentPort } from 'node:worker_threads'; parentPort.postMessage({ status: 'ready' }); setInterval(() => {}, 1000)",
        ),
      }),
    ).rejects.toThrow(/timed out/);
    const progressingWorker = encodeURIComponent(`
      import { parentPort } from "node:worker_threads";
      const timer = setInterval(() => parentPort.postMessage({ status: "progress" }), 100);
      setTimeout(() => {
        clearInterval(timer);
        parentPort.postMessage({ status: "ok" });
      }, 2500);
    `);
    await expect(
      sessionTranscriptSearchTesting.runReconcileWorker({
        agentId: "main",
        stateDir: paths.stateDir,
        timeoutMs: 1000,
        workerUrl: new URL(`data:text/javascript,${progressingWorker}`),
      }),
    ).resolves.toBeUndefined();
    const multiSessionWorker = encodeURIComponent(`
      import { parentPort } from "node:worker_threads";
      parentPort.postMessage({ status: "ready" });
      setTimeout(() => parentPort.postMessage({ status: "started" }), 50);
      setTimeout(() => parentPort.postMessage({ status: "progress" }), 100);
      setTimeout(() => parentPort.postMessage({ status: "ready" }), 150);
      setTimeout(() => parentPort.postMessage({ status: "ok" }), 1500);
    `);
    await expect(
      sessionTranscriptSearchTesting.runReconcileWorker({
        agentId: "main",
        stateDir: paths.stateDir,
        timeoutMs: 1000,
        planningTimeoutMs: 3000,
        workerUrl: new URL(`data:text/javascript,${multiSessionWorker}`),
      }),
    ).resolves.toBeUndefined();
  });

  it("keeps dirty state authoritative across append and rewind races", async () => {
    const scope = transcriptScope("session-1", "agent:main:main");
    await replaceSqliteTranscriptEvents(scope, [
      {
        type: "message",
        id: "m1",
        parentId: null,
        message: { role: "user", content: [{ type: "text", text: "race origin" }] },
      },
      {
        type: "message",
        id: "m2",
        parentId: "m1",
        message: { role: "assistant", content: [{ type: "text", text: "race appended" }] },
      },
    ] as unknown as TranscriptEvent[]);
    const { db, kysely } = agentKysely();
    executeSqliteQuerySync(db, kysely.deleteFrom("session_transcript_fts"));
    executeSqliteQuerySync(db, kysely.deleteFrom("session_transcript_index_state"));

    expect(search("race").indexing).toBe(true);
    await appendUserMessage("session-1", "agent:main:main", "race later");
    expect((await finishReconcile("appended")).hits).toHaveLength(1);

    await appendSqliteTranscriptEvent(scope, {
      type: "leaf",
      id: "rewind",
      parentId: "m2",
      targetId: "m1",
    } as unknown as TranscriptEvent);
    expect(search("appended").hits).toHaveLength(0);
    expect((await finishReconcile("appended")).hits).toHaveLength(0);
  });

  it("does not publish stale same-count replacements or deleted transcripts", async () => {
    const scope = transcriptScope("session-1", "agent:main:main");
    await appendUserMessage("session-1", "agent:main:main", "before replacement");
    const { db, kysely } = agentKysely();
    executeSqliteQuerySync(db, kysely.deleteFrom("session_transcript_fts"));
    executeSqliteQuerySync(db, kysely.deleteFrom("session_transcript_index_state"));
    expect(search("before").indexing).toBe(true);
    await replaceSqliteTranscriptEvents(scope, [
      {
        type: "message",
        id: "replacement",
        parentId: null,
        message: { role: "user", content: [{ type: "text", text: "after replacement" }] },
      },
    ] as unknown as TranscriptEvent[]);
    expect((await finishReconcile("after")).hits).toHaveLength(1);
    expect(search("before").hits).toHaveLength(0);

    executeSqliteQuerySync(db, kysely.deleteFrom("session_transcript_index_state"));
    expect(search("after").indexing).toBe(true);
    await deleteSqliteTranscript({ agentId: "main", env: env(), sessionId: "session-1" });
    await waitForSessionTranscriptReconcileForTest();
    expect(search("after").hits).toHaveLength(0);
  });

  it("detects missing, dirty, and lagging transcript index watermarks", async () => {
    await appendUserMessage("session-1", "agent:main:main", "indexed message");
    const { db, kysely } = agentKysely();
    const pending = () => listSessionsNeedingTranscriptIndexReconcile(db);

    expect(pending()).toEqual([]);

    executeSqliteQuerySync(
      db,
      kysely
        .updateTable("session_transcript_index_state")
        .set({ needs_rebuild: 1 })
        .where("session_id", "=", "session-1"),
    );
    expect(pending()).toEqual(["session-1"]);

    executeSqliteQuerySync(
      db,
      kysely
        .updateTable("session_transcript_index_state")
        .set({ indexed_seq: -1, needs_rebuild: 0 })
        .where("session_id", "=", "session-1"),
    );
    expect(pending()).toEqual(["session-1"]);

    executeSqliteQuerySync(
      db,
      kysely.deleteFrom("session_transcript_index_state").where("session_id", "=", "session-1"),
    );
    expect(pending()).toEqual(["session-1"]);
  });

  it("sweeps orphaned index rows during reconcile", async () => {
    await appendUserMessage("session-1", "agent:main:main", "anchor row");
    const { db, kysely } = agentKysely();
    executeSqliteQuerySync(
      db,
      kysely.insertInto("session_transcript_fts").values({
        text: "ghost payload",
        session_id: "session-ghost",
        message_id: "m-ghost",
        role: "user",
        timestamp: "1",
      }),
    );
    executeSqliteQuerySync(db, kysely.deleteFrom("session_transcript_index_state"));

    const ghostRows = () =>
      executeSqliteQuerySync(
        db,
        kysely
          .selectFrom("session_transcript_fts")
          .select("message_id")
          .where("session_id", "=", "session-ghost"),
      ).rows.length;
    expect(ghostRows()).toBe(1);
    expect(search("anchor").indexing).toBe(true);
    await waitForSearchReconcile("anchor");
    expect(ghostRows()).toBe(0);
    expect(search("anchor").hits).toHaveLength(1);
  });
});
