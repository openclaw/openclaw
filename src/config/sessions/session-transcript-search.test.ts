/** SQLite-native transcript search: in-transaction indexing, reconcile, and query bounds. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  isOpenClawAgentDatabaseOpen,
  openOpenClawAgentDatabase as openDatabase,
  resolveOpenClawAgentSqlitePath,
  runOpenClawAgentWriteTransaction as runWrite,
} from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../../state/openclaw-state-db.js";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../runtime-snapshot.js";
import {
  readSessionTranscriptWatermark as readWatermark,
  type TranscriptEvent,
} from "./session-accessor.js";
import { replaceSessionEntry } from "./session-accessor.sqlite-entry.js";
import { resolveSqliteReadScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import {
  appendTranscriptEvent,
  appendTranscriptMessage,
} from "./session-accessor.sqlite-transcript-write.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.test-support.js";
import {
  restoreSessionColdTranscript,
  runSessionColdStorageMaintenance,
} from "./session-cold-storage.js";
import { createSessionTranscriptFtsInserter as createFtsInserter } from "./session-transcript-fts.js";
import {
  listSessionsNeedingTranscriptIndexReconcile as pendingReconcile,
  SYNC_REBUILD_MAX_BYTES,
} from "./session-transcript-index.js";
import {
  isSessionTranscriptIndexReconcileRunning as isReconciling,
  reconcileSessionTranscriptIndexes as reconcile,
  waitForSessionTranscriptIndexReconcile as waitForReconcile,
} from "./session-transcript-reconcile.js";
import {
  searchSessionTranscripts as searchSessionTranscriptsAsync,
  searchSessionTranscriptsReadOnlySync as readSearch,
} from "./session-transcript-search.js";
import type { SessionTranscriptSearchParams } from "./session-transcript-search.types.js";

vi.mock("../config.js", async () => ({
  ...(await vi.importActual<typeof import("../config.js")>("../config.js")),
  getRuntimeConfig: vi.fn().mockReturnValue({}),
}));

let paths: { stateDir: string; tempDir: string };

beforeEach(() => {
  setRuntimeConfigSnapshot({});
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-session-search-"));
  paths = { stateDir: path.join(tempDir, "state"), tempDir };
});

function env(): NodeJS.ProcessEnv {
  return { ...process.env, OPENCLAW_STATE_DIR: paths.stateDir };
}
const agent = () => ({ agentId: "main", env: env() });

function transcriptScope(sessionId: string, sessionKey = `agent:main:${sessionId}`) {
  return { ...agent(), sessionId, sessionKey };
}

const userMessage = (text: string, role = "user") => ({ role, content: [{ type: "text", text }] });
function messageEvent(id: string, text: string, parentId: string | null = null, role = "user") {
  return { type: "message", id, parentId, message: userMessage(text, role) };
}
async function appendUserMessage(
  sessionId: string,
  text: string,
  sessionKey = `agent:main:${sessionId}`,
) {
  await appendTranscriptMessage(transcriptScope(sessionId, sessionKey), {
    message: userMessage(text),
  });
}
async function seed(...rows: Array<[string, string, string?]>) {
  for (const [id, text, key] of rows) {
    await appendUserMessage(id, text, key);
  }
}

// Keep projection fixtures deterministic; the worker suite covers host scheduling.
function searchSessionTranscripts(params: SessionTranscriptSearchParams) {
  const { found, ...result } = readSearch(params);
  const indexing =
    found &&
    pendingReconcile(openDatabase(toDatabaseOptions(resolveSqliteReadScope(params))).db).length > 0;
  return { ...result, indexing };
}

function search(
  query: string,
  options: Partial<Omit<SessionTranscriptSearchParams, "query">> = {},
) {
  return searchSessionTranscripts({ ...agent(), query, ...options });
}
const hitIds = (query: string, options?: Parameters<typeof search>[1]) =>
  search(query, options).hits.map((hit) => hit.sessionId);
const emptySearch = { hits: [], indexing: false, truncated: false };

async function waitForSearchReconcile(query: string): Promise<void> {
  const options = agent();
  await waitForReconcile(options);
  if (search(query).indexing) {
    await reconcile(options);
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
  resetConfigRuntimeState();
  vi.unstubAllEnvs();
});

function projectionFixture() {
  const { db } = openDatabase(agent());
  // Corrupt derived state directly; ordinary writes still use the accessor above.
  return {
    db,
    indexedRows: (id: string) =>
      db.prepare("SELECT message_id, text FROM session_transcript_fts WHERE session_id=?").all(id),
    updateIndex: (id: string, dirty: number, seq?: number) =>
      db
        .prepare(
          "UPDATE session_transcript_index_state SET needs_rebuild=?, indexed_seq=COALESCE(?, indexed_seq) WHERE session_id=?",
        )
        .run(dirty, seq ?? null, id),
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
        openDatabase({ agentId: "alpha", env: env(), path: storePath });
      }
      await appendTranscriptMessage(
        { agentId, env: env(), sessionId: "session-1", sessionKey, storePath },
        { message: userMessage("readonly search needle") },
      );
      const databasePath = storePath ?? resolveOpenClawAgentSqlitePath({ agentId, env: env() });
      await closeOpenClawAgentDatabasesAsync();
      closeOpenClawAgentDatabasesForTest();

      expect(readSearch({ agentId, env: env(), query: "needle", storePath }).hits).toMatchObject([
        { sessionKey, sessionId: "session-1" },
      ]);
      expect(isOpenClawAgentDatabaseOpen(databasePath)).toBe(false);
    },
  );

  it("scopes omitted filters to a logical namespace in a shared database", async () => {
    const storePath = path.join(paths.tempDir, "shared.sqlite");
    openDatabase({ agentId: "owner", env: env(), path: storePath });
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
        { message: userMessage(text) },
      );
    }
    const params = { agentId: "work_team", env: env(), query: "needle", storePath };
    const keys = (options: Partial<SessionTranscriptSearchParams> = {}) =>
      searchSessionTranscripts({ ...params, ...options })
        .hits.map((hit) => hit.sessionKey)
        .toSorted();
    expect(keys()).toEqual(["agent:work_team:main", "global", "unknown"]);
    expect(searchSessionTranscripts({ ...params, query: "bounded", limit: 1 })).toEqual({
      hits: [expect.objectContaining({ sessionKey: "agent:work_team:main" })],
      indexing: false,
      truncated: false,
    });
    expect(
      searchSessionTranscripts({ ...params, sessionKeys: ["agent:workxteam:main"] }).hits,
    ).toMatchObject([{ sessionKey: "agent:workxteam:main" }]);
    expect(keys({ sessionKeys: [] })).toEqual(
      sessions.map(([, sessionKey]) => sessionKey).toSorted(),
    );
  });

  it("returns empty results without creating a missing database", async () => {
    const databasePath = resolveOpenClawAgentSqlitePath(agent());

    expect(search("missing")).toEqual(emptySearch);
    expect(await searchSessionTranscriptsAsync({ ...agent(), query: "missing" })).toEqual(
      emptySearch,
    );
    expect(fs.existsSync(databasePath)).toBe(false);
    expect(isOpenClawAgentDatabaseOpen(databasePath)).toBe(false);
  });

  it("reports archived search exclusions within the requested scope and searches again after restore", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", paths.stateDir);
    const sessionKey = "agent:main:archived";
    const scope = transcriptScope("old", sessionKey);
    await appendUserMessage("old", "archived needle", sessionKey);
    await replaceSessionEntry(scope, { sessionId: "current", updatedAt: Date.now() });
    const options = agent();
    runWrite(({ db }) => {
      db.prepare(
        "UPDATE session_windows SET updated_at=1, transcript_updated_at=1 WHERE session_id=?",
      ).run(scope.sessionId);
    }, options);
    const watermark = readWatermark(scope);
    await expect(
      runSessionColdStorageMaintenance({
        config: {
          agents: { entries: { main: {} } },
          session: {
            store: resolveOpenClawAgentSqlitePath(options),
            maintenance: { coldStorage: { enabled: true, afterDays: 30 } },
          },
        },
      }),
    ).resolves.toMatchObject({ archivedTranscripts: 1 });
    expect(readWatermark(scope)).toEqual(watermark);
    expect(search("needle", { sessionKeys: [sessionKey] })).toEqual({
      ...emptySearch,
      archivedTranscriptsExcluded: 1,
    });
    expect(search("needle", { sessionKeys: ["agent:main:other"] })).not.toHaveProperty(
      "archivedTranscriptsExcluded",
    );
    await restoreSessionColdTranscript(scope);
    expect(readWatermark(scope)).toEqual(watermark);
    expect(search("needle", { sessionKeys: [sessionKey] })).toMatchObject({
      hits: [{ sessionId: "old", sessionKey }],
      indexing: false,
    });
    expect(search("needle", { sessionKeys: [sessionKey] })).not.toHaveProperty(
      "archivedTranscriptsExcluded",
    );
  });

  it("matches an unfinished final word in prefix mode while preserving literal AND queries", async () => {
    await seed(
      ["complete", "Per-session communication controls in UI"],
      ["missing-word", "Session communication controls in UI"],
      ["earlier-prefixes", "Periodic sessions communication controls in UI"],
      ["literal", 'A literal "OR" keyword in the message'],
    );

    expect(search("per session communi").hits).toEqual([]);
    expect(hitIds("per session communication controls")).toEqual(["complete"]);
    for (const [query, sessionIds] of [
      ["per session communi", ["complete"]],
      ["per-session communi", ["complete"]],
      ['literal "OR" key', ["literal"]],
      ["literal OR missing", []],
      ['"', []],
    ] as const) {
      expect(hitIds(query, { match: "prefix" }), query).toEqual(sessionIds);
    }
  });

  it("ignores standalone punctuation and symbol words that the index never stores", async () => {
    await appendUserMessage("deploy", "Rollback plan: deploy - staging");

    for (const query of [
      "deploy - staging",
      "deploy & staging",
      "deploy -> staging",
      "deploy \u2192 staging",
      "deploy \u3001 staging",
    ]) {
      expect(hitIds(query), query).toEqual(["deploy"]);
    }
    expect(hitIds("deploy staging \u{1F680}")).toEqual(["deploy"]);
    expect(hitIds("deploy - stag", { match: "prefix" })).toEqual(["deploy"]);
    expect(search("deploy missing -").hits).toEqual([]);
    expect(search("- &").hits).toEqual([]);
  });

  it("keeps symbol words that SQLite indexes as tokens", async () => {
    await seed(["lobster", "deploy \u{1F99E}"], ["plain", "deploy plain"]);

    expect(hitIds("deploy \u{1F99E}")).toEqual(["lobster"]);
  });

  it("scopes content reads and bounds snippets while preserving ranked and recent results", async () => {
    const sessionKeys: [string, string] = ["agent:main:permitted", "agent:main:dirty"];
    for (const [id, key] of [
      ["permitted", sessionKeys[0]],
      ["generation", sessionKeys[0]],
      ["dirty", sessionKeys[1]],
      ["excluded", "agent:main:excluded"],
    ] as const) {
      await appendUserMessage(id, "anchor", key);
    }
    runWrite(({ db }) => {
      for (const id of ["permitted", "generation", "dirty", "excluded"]) {
        const insert = createFtsInserter(db, id);
        for (let index = 0; index < 80; index++) {
          insert({
            messageId: `${id}-${String(index).padStart(3, "0")}`,
            text: `needle common payload${index < 10 ? "" : ` ${"padding ".repeat(40)}`}${index === 79 ? "sparse" : ""}`,
            role: index % 2 ? "assistant" : "user",
            timestamp: String(Math.floor(index / 4)),
          });
        }
      }
      db.prepare(
        "UPDATE session_transcript_index_state SET needs_rebuild=1 WHERE session_id='dirty'",
      ).run();
    }, agent());

    // The native method is always invoked with its captured connection below.
    // oxlint-disable-next-line typescript/unbound-method
    const prepare = DatabaseSync.prototype.prepare;
    const statements: Array<[DatabaseSync, string, Parameters<StatementSync["all"]>]> = [];
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
                statements.push([this, query, bindings]);
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
        { limit: 25 },
        { limit: 25, order: "recent" },
        { limit: 3, sessionId: "permitted", role: "assistant" },
        { limit: 3, sessionId: "permitted", role: "assistant", order: "recent" },
        { limit: 3, query: "need", match: "prefix" },
        { limit: 25, query: "sparse" },
        { limit: 25, sessionId: "dirty" },
      ] satisfies Partial<SessionTranscriptSearchParams>[]) {
        statements.length = 0;
        const result = search("needle", { sessionKeys, ...options });
        expect(statements).toHaveLength(1);
        const [db, query, bindings] = statements[0]!;
        const all = (sql: string, params = bindings) => prepare.call(db, sql).all(...params);
        const literal = options.match === "prefix" ? '"need"*' : `"${options.query ?? "needle"}"`;
        // The previous query is the equivalence oracle; it still pays the unbounded snippet cost.
        const baseline = all(
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
          [
            literal,
            JSON.stringify(sessionKeys),
            ...(options.sessionId ? [options.sessionId] : []),
            ...(options.role ? [options.role] : []),
            options.limit + 1,
          ],
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
        expect(all(counted)).toHaveLength(baseline.length);
        expect(snippets).toBe(baseline.length);
        expect(snippets).toBeLessThanOrEqual(options.limit + 1);
        const plan = all(`EXPLAIN QUERY PLAN ${query}`).map((row) => String(row.detail));
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
        const bytecode = all(`EXPLAIN ${query}`);
        const matchScan = bytecode.find((row) => row.opcode === "VFilter" && row.p4 === "M5")!;
        const firstContent = bytecode.find(
          (row) => row.opcode === "VColumn" && row.p1 === matchScan.p1 && Number(row.p2) < 5,
        );
        const scopeCheck = bytecode.find((row) => row.opcode === "NotFound")!;
        if (options.role || options.order === "recent") {
          expect(Number(firstContent?.addr)).toBeGreaterThan(Number(scopeCheck.addr));
        } else {
          // Ranking rejects losing scores without loading their FTS content columns.
          expect(firstContent).toBeUndefined();
        }
      }
    } finally {
      spy.mockRestore();
    }
  });

  it("hides dirty search rows after their transcript is gone while preserving other sessions", async () => {
    await seed(["stale", "hidden needle"], ["current", "visible needle"]);
    const { db, updateIndex } = projectionFixture();
    updateIndex("stale", 1);
    db.prepare("DELETE FROM transcript_events WHERE session_id=?").run("stale");

    // A retained window can hold stale FTS rows even when no hot transcript needs reconciliation.
    expect(pendingReconcile(db)).toEqual([]);
    expect(search("needle", { sessionId: "stale" })).toMatchObject({ hits: [], indexing: false });
    expect(search("needle", { sessionId: "current" })).toMatchObject({
      hits: [{ sessionId: "current", snippet: expect.stringContaining("visible needle") }],
      indexing: false,
    });
  });

  it("rejects empty and oversized queries", () => {
    expect(() => search("   ")).toThrow(/query must not be empty/);
    expect(() => search("x".repeat(4097))).toThrow(/must not exceed/);
  });

  it("preserves stale FTS rows until a replaced transcript is reconciled after commit", async () => {
    await appendUserMessage("session-1", "obsolete branch text", "agent:main:main");
    const { db, indexedRows: rows } = projectionFixture();
    const indexedRows = () => rows("session-1");
    const originalIndexedRows = indexedRows();
    expect(originalIndexedRows).toMatchObject([{ text: "obsolete branch text" }]);
    await replaceTranscriptEvents(transcriptScope("session-1", "agent:main:main"), [
      {
        ...messageEvent("m-new", "replacement text"),
        padding: "x".repeat(SYNC_REBUILD_MAX_BYTES),
        timestamp: 1720000000000,
      } as unknown as TranscriptEvent,
    ]);

    expect(indexedRows()).toEqual(originalIndexedRows);
    expect(
      db
        .prepare("SELECT needs_rebuild FROM session_transcript_index_state WHERE session_id=?")
        .all("session-1"),
    ).toEqual([{ needs_rebuild: 1 }]);
    expect(isReconciling(agent())).toBe(true);
    expect(search("obsolete")).toMatchObject({ hits: [], indexing: true });
    expect(search("replacement")).toMatchObject({ hits: [], indexing: true });
    const scope = transcriptScope("session-1", "agent:main:main");
    const pendingWatermark = readWatermark(scope);

    await waitForReconcile(agent());
    expect(readWatermark(scope)).toEqual(pendingWatermark);

    expect(search("obsolete").hits).toHaveLength(0);
    expect(search("replacement")).toMatchObject({
      indexing: false,
      hits: [{ messageId: "m-new" }],
    });
  });

  it.each([
    [
      "only surfaces the active branch after a deferred leaf-control rebuild",
      ["alpha origin", "beta abandoned"],
      0,
      false,
    ],
    [
      "streams large searchable projections to the writer in bounded chunks",
      ["alpha-stream", "beta-stream", "gamma-stream"],
      2,
      true,
    ],
  ] as const)("%s", async (_name, texts, target, large) => {
    const queries = texts.map((text) => text.split(" ")[0]!);
    const scope = transcriptScope("session-1", "agent:main:main");
    await replaceTranscriptEvents(
      scope,
      texts.map((text, index) =>
        messageEvent(
          `m${index + 1}`,
          large ? `${text} ${"x".repeat(140 * 1024)}` : text,
          index === 0 ? null : `m${index}`,
          !large && index === 1 ? "assistant" : "user",
        ),
      ) as unknown as TranscriptEvent[],
    );
    await appendTranscriptEvent(scope, {
      type: "leaf",
      id: "leaf",
      parentId: `m${texts.length}`,
      targetId: `m${target + 1}`,
    } as unknown as TranscriptEvent);
    const query = queries.at(-1)!;
    expect(search(query)).toMatchObject({ indexing: true, hits: [] });
    await waitForSearchReconcile(query);
    for (const [index, term] of queries.entries()) {
      expect(search(term).hits, term).toHaveLength(index <= target ? 1 : 0);
    }
  });

  it("detects missing, dirty, lagging, and unclassified transcript projections", async () => {
    await appendUserMessage("session-0", "indexed sibling", "agent:main:sibling");
    await appendUserMessage("session-1", "indexed message", "agent:main:main");
    const { db, updateIndex } = projectionFixture();
    const pending = () => pendingReconcile(db);
    const expectPending = () => {
      expect(pending()).toEqual(["session-1"]);
      expect(search("indexed").indexing).toBe(true);
    };

    expect(pending()).toEqual([]);
    expect(search("indexed").indexing).toBe(false);
    expect(search("indexed").hits).toHaveLength(2);

    for (const [dirty, seq] of [
      [1, undefined],
      [0, -1],
    ] as const) {
      updateIndex("session-1", dirty, seq);
      expectPending();
      await waitForSearchReconcile("indexed");
    }

    db.prepare(
      "UPDATE session_transcript_active_events SET context_eligible=NULL WHERE session_id=?",
    ).run("session-1");
    expect(pending()).toEqual(["session-1"]);
    expect(search("indexed", { sessionKeys: ["agent:main:sibling"] })).toMatchObject({
      hits: [{ sessionId: "session-0", snippet: "indexed sibling" }],
      indexing: true,
    });
    await waitForSearchReconcile("indexed");
    expect(search("indexed", { sessionKeys: ["agent:main:sibling"] }).indexing).toBe(false);

    db.prepare("DELETE FROM session_transcript_index_state WHERE session_id=?").run("session-1");
    expectPending();
  });

  it("sweeps orphaned index rows even when transcript watermarks are current", async () => {
    await appendUserMessage("session-1", "anchor row", "agent:main:main");
    await appendUserMessage("session-2", "anchor sibling", "agent:main:sibling");
    const { db, indexedRows } = projectionFixture();
    const expectSwept = async (
      table: "session_transcript_active_events" | "session_transcript_index_state",
      id: string,
    ) => {
      await reconcile(agent());
      expect(db.prepare(`SELECT 1 FROM ${table} WHERE session_id = ?`).get(id)).toBeUndefined();
    };
    // Simulate derived rows left by an out-of-band writer with foreign keys disabled.
    db.exec(`
      PRAGMA foreign_keys = OFF;
      INSERT INTO session_transcript_active_events
        (session_id, active_position, event_seq, context_eligible)
        VALUES ('active-ghost', 0, 0, 1);
      PRAGMA foreign_keys = ON;
    `);
    await expectSwept("session_transcript_active_events", "active-ghost");

    runWrite((database) => {
      const insert = createFtsInserter(database.db, "session-ghost");
      insert({
        text: "ghost payload",
        messageId: "m-ghost",
        role: "user",
        timestamp: "1",
      });
    }, agent());

    const ghostRows = () => indexedRows("session-ghost").length;
    expect(ghostRows()).toBe(1);
    expect(search("anchor").indexing).toBe(false);
    await reconcile(agent());
    expect(ghostRows()).toBe(0);

    db.exec(`
      PRAGMA foreign_keys = OFF;
      INSERT INTO session_transcript_index_state (session_id, indexed_seq, updated_at)
        VALUES ('state-ghost', 0, 1);
      PRAGMA foreign_keys = ON;
    `);
    await expectSwept("session_transcript_index_state", "state-ghost");
    expect(hitIds("anchor").toSorted()).toEqual(["session-1", "session-2"]);
  });
});
