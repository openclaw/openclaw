/** SQLite-native transcript search: in-transaction indexing, reconcile, and query bounds. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  isOpenClawAgentDatabaseOpen,
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../../state/openclaw-state-db.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { readSessionTranscriptWatermark, type TranscriptEvent } from "./session-accessor.js";
import { replaceSessionEntry } from "./session-accessor.sqlite-entry.js";
import {
  appendTranscriptEvent,
  appendTranscriptMessage,
  replaceTranscriptEvents,
} from "./session-accessor.sqlite-transcript-write.js";
import {
  restoreSessionColdTranscript,
  runSessionColdStorageMaintenance,
} from "./session-cold-storage.js";
import { createSessionTranscriptFtsInserter } from "./session-transcript-fts.js";
import {
  listSessionsNeedingTranscriptIndexReconcile,
  SYNC_REBUILD_MAX_BYTES,
} from "./session-transcript-index.js";
import {
  isSessionTranscriptIndexReconcileRunning,
  reconcileSessionTranscriptIndexes,
  waitForSessionTranscriptIndexReconcile,
} from "./session-transcript-reconcile.js";
import { searchSessionTranscriptsReadOnlySync as searchSessionTranscripts } from "./session-transcript-search.js";
import type { SessionTranscriptSearchParams } from "./session-transcript-search.types.js";

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
  await appendTranscriptMessage(transcriptScope(sessionId, sessionKey), {
    message: { role: "user", content: [{ type: "text", text }] },
  });
}

async function appendAssistantMessage(sessionId: string, sessionKey: string, text: string) {
  await appendTranscriptMessage(transcriptScope(sessionId, sessionKey), {
    message: { role: "assistant", content: [{ type: "text", text }] },
  });
}

function search(
  query: string,
  options: { limit?: number; sessionKeys?: string[]; match?: "prefix" } = {},
) {
  return searchSessionTranscripts({
    agentId: "main",
    env: env(),
    query,
    ...(options.limit !== undefined ? { limit: options.limit } : {}),
    ...(options.sessionKeys ? { sessionKeys: options.sessionKeys } : {}),
    ...(options.match ? { match: options.match } : {}),
  });
}

async function waitForSearchReconcile(query: string): Promise<void> {
  const options = { agentId: "main", env: env() };
  await waitForSessionTranscriptIndexReconcile(options);
  if (search(query).indexing) {
    await reconcileSessionTranscriptIndexes(options);
  }
  expect(search(query).indexing).toBe(false);
}

afterEach(async () => {
  await waitForSearchReconcile("cleanup-probe");
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  fs.rmSync(paths.tempDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

function agentKysely() {
  const database = openOpenClawAgentDatabase({ agentId: "main", env: env() });
  return {
    db: database.db,
    kysely: getNodeSqliteKysely<
      Pick<
        OpenClawAgentKyselyDatabase,
        | "session_transcript_active_events"
        | "session_transcript_fts"
        | "session_transcript_fts_rows"
        | "session_transcript_index_state"
        | "transcript_events"
      >
    >(database.db),
  };
}

describe("searchSessionTranscripts", () => {
  it.each([false, true])(
    "searches a populated closed database without reopening a writer (shared: %s)",
    async (shared) => {
      const agentId = shared ? "beta" : "main";
      const sessionKey = `agent:${agentId}:main`;
      const storePath = shared ? path.join(paths.tempDir, "shared.sqlite") : undefined;
      if (shared) {
        openOpenClawAgentDatabase({ agentId: "alpha", env: env(), path: storePath });
      }
      await appendTranscriptMessage(
        { agentId, env: env(), sessionId: "session-1", sessionKey, storePath },
        { message: { role: "user", content: [{ type: "text", text: "readonly search needle" }] } },
      );
      const databasePath = storePath ?? resolveOpenClawAgentSqlitePath({ agentId, env: env() });
      await closeOpenClawAgentDatabasesAsync();
      closeOpenClawAgentDatabasesForTest();

      expect(
        searchSessionTranscripts({ agentId, env: env(), query: "needle", storePath }).hits,
      ).toEqual([expect.objectContaining({ sessionKey, sessionId: "session-1" })]);
      expect(isOpenClawAgentDatabaseOpen(databasePath)).toBe(false);
    },
  );

  it("scopes omitted filters to a logical namespace in a shared database", async () => {
    const storePath = path.join(paths.tempDir, "shared.sqlite");
    openOpenClawAgentDatabase({ agentId: "owner", env: env(), path: storePath });
    const sessions = [
      ["work_team", "agent:work_team:main"],
      ["workxteam", "agent:workxteam:main"],
      ["owner", "agent:owner:main"],
      ["owner", "global"],
      ["owner", "unknown"],
    ] as const;
    for (const [index, [agentId, sessionKey]] of sessions.entries()) {
      const text =
        agentId === "work_team"
          ? `needle bounded ${"context ".repeat(30)}`
          : agentId === "workxteam"
            ? "needle bounded"
            : "needle";
      await appendTranscriptMessage(
        { agentId, env: env(), sessionId: `session-${index}`, sessionKey, storePath },
        { message: { role: "user", content: [{ type: "text", text }] } },
      );
    }
    const params = { agentId: "work_team", env: env(), query: "needle", storePath };
    expect(
      searchSessionTranscripts(params)
        .hits.map((hit) => hit.sessionKey)
        .toSorted(),
    ).toEqual(["agent:work_team:main", "global", "unknown"]);
    expect(searchSessionTranscripts({ ...params, query: "bounded", limit: 1 })).toEqual({
      hits: [expect.objectContaining({ sessionKey: "agent:work_team:main" })],
      indexing: false,
      truncated: false,
    });
    expect(
      searchSessionTranscripts({ ...params, sessionKeys: ["agent:workxteam:main"] }).hits,
    ).toEqual([expect.objectContaining({ sessionKey: "agent:workxteam:main" })]);
    expect(
      searchSessionTranscripts({ ...params, sessionKeys: [] })
        .hits.map((hit) => hit.sessionKey)
        .toSorted(),
    ).toEqual(sessions.map(([, sessionKey]) => sessionKey).toSorted());
  });

  it("returns empty results without creating a missing database", () => {
    const databasePath = resolveOpenClawAgentSqlitePath({ agentId: "main", env: env() });

    expect(search("missing")).toEqual({ hits: [], indexing: false, truncated: false });
    expect(fs.existsSync(databasePath)).toBe(false);
    expect(isOpenClawAgentDatabaseOpen(databasePath)).toBe(false);
  });

  it("reports archived search exclusions within the requested scope and searches again after restore", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", paths.stateDir);
    const sessionKey = "agent:main:archived";
    const scope = transcriptScope("old", sessionKey);
    await appendUserMessage("old", sessionKey, "archived needle");
    await replaceSessionEntry(scope, { sessionId: "current", updatedAt: Date.now() });
    const options = { agentId: "main", env: env() };
    runOpenClawAgentWriteTransaction(({ db }) => {
      executeSqliteQuerySync(
        db,
        getNodeSqliteKysely<OpenClawAgentKyselyDatabase>(db)
          .updateTable("session_windows")
          .set({ updated_at: 1, transcript_updated_at: 1 })
          .where("session_id", "=", scope.sessionId),
      );
    }, options);
    const watermark = readSessionTranscriptWatermark(scope);
    await expect(
      withEnvAsync({ OPENCLAW_STATE_DIR: paths.stateDir }, () =>
        runSessionColdStorageMaintenance({
          config: {
            agents: { entries: { main: {} } },
            session: {
              store: resolveOpenClawAgentSqlitePath(options),
              maintenance: { coldStorage: { enabled: true, afterDays: 30 } },
            },
          },
        }),
      ),
    ).resolves.toMatchObject({ archivedTranscripts: 1 });
    expect(readSessionTranscriptWatermark(scope)).toEqual(watermark);
    expect(search("needle", { sessionKeys: [sessionKey] })).toEqual({
      hits: [],
      indexing: false,
      truncated: false,
      archivedTranscriptsExcluded: 1,
    });
    expect(search("needle", { sessionKeys: ["agent:main:other"] })).not.toHaveProperty(
      "archivedTranscriptsExcluded",
    );
    await restoreSessionColdTranscript(scope);
    expect(readSessionTranscriptWatermark(scope)).toEqual(watermark);
    expect(search("needle", { sessionKeys: [sessionKey] })).toMatchObject({
      hits: [expect.objectContaining({ sessionId: "old", sessionKey })],
      indexing: false,
    });
    expect(search("needle", { sessionKeys: [sessionKey] })).not.toHaveProperty(
      "archivedTranscriptsExcluded",
    );
  });

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

  it("matches an unfinished final word in prefix mode while preserving literal AND queries", async () => {
    for (const [sessionId, text] of [
      ["complete", "Per-session communication controls in UI"],
      ["missing-word", "Session communication controls in UI"],
      ["earlier-prefixes", "Periodic sessions communication controls in UI"],
      ["literal", 'A literal "OR" keyword in the message'],
    ] as const) {
      await appendUserMessage(sessionId, `agent:main:${sessionId}`, text);
    }

    expect(search("per session communi").hits).toEqual([]);
    expect(search("per session communication controls").hits).toEqual([
      expect.objectContaining({ sessionId: "complete" }),
    ]);
    for (const [query, sessionIds] of [
      ["per session communi", ["complete"]],
      ["per-session communi", ["complete"]],
      ['literal "OR" key', ["literal"]],
      ["literal OR missing", []],
      ['"', []],
    ] as const) {
      expect(
        search(query, { match: "prefix" }).hits.map((hit) => hit.sessionId),
        query,
      ).toEqual(sessionIds);
    }
  });

  it("ignores non-message events and misses non-matching queries", async () => {
    await appendUserMessage("session-1", "agent:main:main", "alpha topic");
    await appendTranscriptEvent(transcriptScope("session-1", "agent:main:main"), {
      type: "model_change",
      id: "model-change-1",
      model: "sonnet-4.6",
    } as unknown as TranscriptEvent);

    expect(search("sonnet").hits).toHaveLength(0);
    expect(search("alpha").hits).toHaveLength(1);
  });

  it.each([1, 33_000])("filters hits to %i requested session keys", async (keyCount) => {
    await appendUserMessage("session-1", "agent:main:main", "shared keyword payload");
    await appendUserMessage("session-2", "agent:main:other", "shared keyword payload");

    const all = search("keyword");
    expect(all.hits).toHaveLength(2);

    const sessionKeys = Array.from(
      { length: keyCount - 1 },
      (_, index) => `agent:main:missing-${index}`,
    );
    sessionKeys.push("agent:main:other");
    const filtered = search("keyword", { sessionKeys });
    expect(filtered.hits).toHaveLength(1);
    expect(filtered.hits[0]?.sessionKey).toBe("agent:main:other");
    expect(filtered.hits[0]?.sessionId).toBe("session-2");
  });

  it("scopes content reads and bounds snippets while preserving ranked and recent results", async () => {
    const sessionKeys: [string, string] = ["agent:main:permitted", "agent:main:dirty"];
    for (const [id, key] of [
      ["permitted", sessionKeys[0]],
      ["generation", sessionKeys[0]],
      ["dirty", sessionKeys[1]],
      ["excluded", "agent:main:excluded"],
    ] as const) {
      await appendUserMessage(id, key, "anchor");
    }
    runOpenClawAgentWriteTransaction(
      ({ db }) => {
        for (const id of ["permitted", "generation", "dirty", "excluded"]) {
          const insert = createSessionTranscriptFtsInserter(db, id);
          for (let index = 0; index < 80; index++) {
            insert({
              messageId: `${id}-${String(index).padStart(3, "0")}`,
              text: "needle common payload",
              role: index % 2 ? "assistant" : "user",
              timestamp: String(Math.floor(index / 4)),
            });
          }
        }
        db.prepare(
          "UPDATE session_transcript_index_state SET needs_rebuild=1 WHERE session_id='dirty'",
        ).run();
      },
      { agentId: "main", env: env() },
    );

    // The native method is always invoked with its captured connection below.
    // oxlint-disable-next-line typescript/unbound-method
    const prepare = DatabaseSync.prototype.prepare;
    const statements: Array<{
      db: DatabaseSync;
      query: string;
      bindings: Parameters<StatementSync["all"]>;
    }> = [];
    const spy = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (
      this: DatabaseSync,
      query,
    ) {
      const statement = prepare.call(this, query);
      if (query.includes("snippet(")) {
        // Older Node bindings execute Kysely reads through iterate() instead of all().
        for (const method of ["all", "iterate"] as const) {
          const execute = statement[method].bind(statement);
          vi.spyOn(statement, method).mockImplementation(
            new Proxy(execute, {
              apply: (target, receiver, bindings: Parameters<StatementSync["all"]>) => {
                statements.push({ db: this, query, bindings });
                return Reflect.apply(target, receiver, bindings);
              },
            }),
          );
        }
      }
      return statement;
    });
    try {
      for (const options of [
        { limit: 3 },
        { limit: 25, order: "recent" },
        { limit: 3, sessionId: "permitted", role: "assistant" },
        { limit: 3, sessionId: "permitted", role: "assistant", order: "recent" },
        { limit: 3, query: "need", match: "prefix" },
        { limit: 25, sessionId: "dirty" },
      ] satisfies Partial<SessionTranscriptSearchParams>[]) {
        statements.length = 0;
        const result = searchSessionTranscripts({
          agentId: "main",
          env: env(),
          query: "needle",
          sessionKeys,
          ...options,
        });
        expect(statements).toHaveLength(1);
        const captured = statements[0]!;
        const { db, query, bindings } = captured;
        const literal = options.match === "prefix" ? '"need"*' : '"needle"';
        // The previous query is the equivalence oracle; it still pays the unbounded snippet cost.
        const baseline = prepare
          .call(
            db,
            `
          SELECT w.session_key, f.session_id, f.message_id, f.role, f.timestamp,
            snippet(session_transcript_fts, 0, '', '', ' … ', 48) AS snippet,
            bm25(session_transcript_fts) AS rank
          FROM session_transcript_fts f JOIN session_windows w ON w.session_id=f.session_id
          WHERE session_transcript_fts MATCH ?
            AND w.session_key IN (SELECT value FROM json_each(?))
            AND f.session_id NOT IN (SELECT session_id FROM session_transcript_index_state WHERE needs_rebuild!=0)
            ${options.sessionId ? "AND f.session_id=?" : ""}
            ${options.role ? "AND f.role=?" : ""}
          ORDER BY ${options.order === "recent" ? "f.timestamp DESC, f.rowid DESC" : "rank ASC, f.timestamp DESC, f.message_id ASC"}
          LIMIT ?`,
          )
          .all(
            literal,
            JSON.stringify(sessionKeys),
            ...(options.sessionId ? [options.sessionId] : []),
            ...(options.role ? [options.role] : []),
            options.limit + 1,
          );
        expect(result.hits).toEqual(
          baseline.slice(0, options.limit).map((row) => ({
            sessionKey: row.session_key,
            sessionId: row.session_id,
            messageId: row.message_id,
            role: row.role,
            timestamp: Number(row.timestamp),
            snippet: row.snippet,
            score: -Number(row.rank),
          })),
        );
        expect(result.truncated).toBe(baseline.length > options.limit);
        expect(
          result.hits.every((hit) => hit.sessionId !== "dirty" && hit.sessionId !== "excluded"),
        ).toBe(true);
        let snippets = 0;
        db.function("count_search_snippet", (value) => {
          snippets++;
          return value;
        });
        const counted = query.replace(/(snippet\([^)]*\))/u, "count_search_snippet($1)");
        expect(prepare.call(db, counted).all(...bindings)).toHaveLength(baseline.length);
        expect(snippets).toBe(baseline.length);
        expect(snippets).toBeLessThanOrEqual(options.limit + 1);
        const plan = prepare
          .call(db, `EXPLAIN QUERY PLAN ${query}`)
          .all(...bindings)
          .map((row) => String(row.detail));
        expect(plan).toEqual(
          expect.arrayContaining([
            expect.stringContaining("MATERIALIZE hits"),
            expect.stringMatching(/SEARCH mapped USING INTEGER PRIMARY KEY/),
            expect.stringMatching(/session_windows.*\(session_id=\?\)/),
            expect.stringMatching(/VIRTUAL TABLE INDEX .*:=M5/),
          ]),
        );
        expect(plan.filter((line) => /VIRTUAL TABLE INDEX .*:M5$/.test(line))).toHaveLength(1);
        // SQLite bytecode must reject the key set before requesting any outer FTS content.
        const bytecode = prepare.call(db, `EXPLAIN ${query}`).all(...bindings);
        const matchScan = bytecode.find((row) => row.opcode === "VFilter" && row.p4 === "M5")!;
        const firstContent = bytecode.find(
          (row) => row.opcode === "VColumn" && row.p1 === matchScan.p1,
        )!;
        const scopeCheck = bytecode.find((row) => row.opcode === "NotFound")!;
        expect(Number(firstContent.addr)).toBeGreaterThan(Number(scopeCheck.addr));
      }
    } finally {
      spy.mockRestore();
    }
  });

  it("filters role and generation before selecting the most recent matching messages", async () => {
    const sessionKey = "agent:main:main";
    await appendAssistantMessage("current", sessionKey, "needle oldest");
    await appendAssistantMessage("current", sessionKey, `needle latest ${"context ".repeat(30)}`);
    for (let index = 0; index < 28; index += 1) {
      await appendUserMessage("current", sessionKey, "needle user");
    }
    await appendAssistantMessage("other-generation", sessionKey, "needle other generation");

    expect(
      searchSessionTranscripts({
        agentId: "main",
        env: env(),
        query: "needle",
        sessionKeys: [sessionKey],
        sessionId: "current",
        role: "assistant",
        order: "recent",
        limit: 1,
      }),
    ).toMatchObject({
      hits: [
        { sessionId: "current", role: "assistant", snippet: expect.stringContaining("latest") },
      ],
      truncated: true,
    });
  });

  it("hides dirty search rows after their transcript is gone while preserving other sessions", async () => {
    await appendUserMessage("stale", "agent:main:stale", "hidden needle");
    await appendUserMessage("current", "agent:main:current", "visible needle");
    const { db, kysely } = agentKysely();
    executeSqliteQuerySync(
      db,
      kysely
        .updateTable("session_transcript_index_state")
        .set({ needs_rebuild: 1 })
        .where("session_id", "=", "stale"),
    );
    executeSqliteQuerySync(
      db,
      kysely.deleteFrom("transcript_events").where("session_id", "=", "stale"),
    );

    // A retained window can hold stale FTS rows even when no hot transcript needs reconciliation.
    expect(listSessionsNeedingTranscriptIndexReconcile(db)).toEqual([]);
    const params = { agentId: "main", env: env(), query: "needle" };
    expect(searchSessionTranscripts({ ...params, sessionId: "stale" })).toMatchObject({
      hits: [],
      indexing: false,
    });
    expect(searchSessionTranscripts({ ...params, sessionId: "current" })).toMatchObject({
      hits: [{ sessionId: "current", snippet: expect.stringContaining("visible needle") }],
      indexing: false,
    });
  });

  it("rejects empty and oversized queries", () => {
    expect(() => search("   ")).toThrow(/query must not be empty/);
    expect(() => search("x".repeat(4097))).toThrow(/must not exceed/);
  });

  it("preserves stale FTS rows until a replaced transcript is reconciled after commit", async () => {
    await appendUserMessage("session-1", "agent:main:main", "obsolete branch text");
    const { db, kysely } = agentKysely();
    const indexedRows = () =>
      executeSqliteQuerySync(
        db,
        kysely
          .selectFrom("session_transcript_fts")
          .select(["message_id", "text"])
          .where("session_id", "=", "session-1"),
      ).rows;
    const originalIndexedRows = indexedRows();
    expect(originalIndexedRows).toEqual([
      expect.objectContaining({ text: "obsolete branch text" }),
    ]);
    await replaceTranscriptEvents(transcriptScope("session-1", "agent:main:main"), [
      {
        type: "message",
        id: "m-new",
        parentId: null,
        message: { role: "user", content: [{ type: "text", text: "replacement text" }] },
        padding: "x".repeat(SYNC_REBUILD_MAX_BYTES),
        timestamp: 1720000000000,
      } as unknown as TranscriptEvent,
    ]);

    expect(indexedRows()).toEqual(originalIndexedRows);
    expect(
      executeSqliteQuerySync(
        db,
        kysely
          .selectFrom("session_transcript_index_state")
          .select("needs_rebuild")
          .where("session_id", "=", "session-1"),
      ).rows,
    ).toEqual([{ needs_rebuild: 1 }]);
    expect(isSessionTranscriptIndexReconcileRunning({ agentId: "main", env: env() })).toBe(true);
    expect(search("obsolete")).toMatchObject({ hits: [], indexing: true });
    expect(search("replacement")).toMatchObject({ hits: [], indexing: true });
    const scope = transcriptScope("session-1", "agent:main:main");
    const pendingWatermark = readSessionTranscriptWatermark(scope);

    await waitForSessionTranscriptIndexReconcile({ agentId: "main", env: env() });
    expect(readSessionTranscriptWatermark(scope)).toEqual(pendingWatermark);

    expect(search("obsolete").hits).toHaveLength(0);
    const result = search("replacement");
    expect(result.indexing).toBe(false);
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.messageId).toBe("m-new");
  });

  it("only surfaces the active branch after a deferred leaf-control rebuild", async () => {
    const scope = transcriptScope("session-1", "agent:main:main");
    await replaceTranscriptEvents(scope, [
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
    await appendTranscriptEvent(scope, {
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

  it("streams large searchable projections to the writer in bounded chunks", async () => {
    const scope = transcriptScope("session-1", "agent:main:main");
    const largeText = "x".repeat(140 * 1024);
    await replaceTranscriptEvents(
      scope,
      ["alpha-stream", "beta-stream", "gamma-stream"].map((marker, index) => ({
        type: "message",
        id: `m${index + 1}`,
        parentId: index === 0 ? null : `m${index}`,
        message: { role: "user", content: [{ type: "text", text: `${marker} ${largeText}` }] },
      })) as unknown as TranscriptEvent[],
    );
    await appendTranscriptEvent(scope, {
      type: "leaf",
      id: "leaf-large",
      parentId: "m3",
      targetId: "m3",
    } as unknown as TranscriptEvent);

    expect(search("gamma-stream").indexing).toBe(true);
    await waitForSearchReconcile("gamma-stream");

    expect(search("alpha-stream").hits).toHaveLength(1);
    expect(search("beta-stream").hits).toHaveLength(1);
    expect(search("gamma-stream").hits).toHaveLength(1);
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

  it("detects missing, dirty, lagging, and unclassified transcript projections", async () => {
    await appendUserMessage("session-0", "agent:main:sibling", "indexed sibling");
    await appendUserMessage("session-1", "agent:main:main", "indexed message");
    const { db, kysely } = agentKysely();
    const pending = () => listSessionsNeedingTranscriptIndexReconcile(db);

    expect(pending()).toEqual([]);
    expect(search("indexed").indexing).toBe(false);
    expect(search("indexed").hits).toHaveLength(2);

    executeSqliteQuerySync(
      db,
      kysely
        .updateTable("session_transcript_index_state")
        .set({ needs_rebuild: 1 })
        .where("session_id", "=", "session-1"),
    );
    expect(pending()).toEqual(["session-1"]);
    expect(search("indexed").indexing).toBe(true);
    await waitForSearchReconcile("indexed");

    executeSqliteQuerySync(
      db,
      kysely
        .updateTable("session_transcript_index_state")
        .set({ indexed_seq: -1, needs_rebuild: 0 })
        .where("session_id", "=", "session-1"),
    );
    expect(pending()).toEqual(["session-1"]);
    expect(search("indexed").indexing).toBe(true);
    await waitForSearchReconcile("indexed");

    executeSqliteQuerySync(
      db,
      kysely
        .updateTable("session_transcript_active_events")
        .set({ context_eligible: null })
        .where("session_id", "=", "session-1"),
    );
    expect(pending()).toEqual(["session-1"]);
    expect(search("indexed", { sessionKeys: ["agent:main:sibling"] })).toMatchObject({
      hits: [{ sessionId: "session-0", snippet: "indexed sibling" }],
      indexing: true,
    });
    await waitForSearchReconcile("indexed");
    expect(search("indexed", { sessionKeys: ["agent:main:sibling"] }).indexing).toBe(false);

    executeSqliteQuerySync(
      db,
      kysely.deleteFrom("session_transcript_index_state").where("session_id", "=", "session-1"),
    );
    expect(pending()).toEqual(["session-1"]);
    expect(search("indexed").indexing).toBe(true);
  });

  it("sweeps orphaned index rows even when transcript watermarks are current", async () => {
    await appendUserMessage("session-1", "agent:main:main", "anchor row");
    const { db, kysely } = agentKysely();
    runOpenClawAgentWriteTransaction(
      (database) =>
        createSessionTranscriptFtsInserter(
          database.db,
          "session-ghost",
        )({
          text: "ghost payload",
          messageId: "m-ghost",
          role: "user",
          timestamp: "1",
        }),
      { agentId: "main", env: env() },
    );

    const ghostRows = () =>
      executeSqliteQuerySync(
        db,
        kysely
          .selectFrom("session_transcript_fts")
          .select("message_id")
          .where("session_id", "=", "session-ghost"),
      ).rows.length;
    expect(ghostRows()).toBe(1);
    expect(search("anchor").indexing).toBe(false);
    await reconcileSessionTranscriptIndexes({ agentId: "main", env: env() });
    expect(ghostRows()).toBe(0);
    expect(search("anchor").hits).toHaveLength(1);
  });
});
