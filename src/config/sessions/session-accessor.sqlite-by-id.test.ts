import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as sqliteQueries from "../../infra/kysely-sync.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  listSessionEntriesReadOnly,
  loadSessionEntryByIdReadOnly,
  replaceSessionEntrySync,
} from "./session-accessor.js";
import { ensureTranscriptSessionRoot } from "./session-accessor.sqlite-transcript-state.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  vi.restoreAllMocks();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

describe("current session ID entry reads", () => {
  it.each(["full", "list"] as const)(
    "preserves visible listing order and excludes retained generations (%s)",
    (projection) => {
      const env = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-session-by-id-") };
      const scope = { agentId: "main", env, projection };
      for (const name of ["z-shared", "a-shared", "internal-session-effects:shared"]) {
        replaceSessionEntrySync(
          { ...scope, sessionKey: `agent:main:${name}` },
          {
            sessionId: "shared",
            updatedAt: 1,
            label: name,
            spawnDepth: 2,
            skillsSnapshot: { prompt: "saved prompt", skills: [] },
          },
        );
      }
      replaceSessionEntrySync(
        { ...scope, sessionKey: "agent:main:internal-session-effects:hidden" },
        { sessionId: "hidden", updatedAt: 1 },
      );
      for (const sessionId of ["previous", "current"]) {
        replaceSessionEntrySync(
          { ...scope, sessionKey: "agent:main:rolled-over" },
          { sessionId, updatedAt: 1 },
        );
      }
      runOpenClawAgentWriteTransaction((database) => {
        ensureTranscriptSessionRoot(
          database,
          { ...scope, sessionKey: "agent:main:retained", sessionId: "retained" },
          1,
        );
      }, scope);

      const selected = loadSessionEntryByIdReadOnly({ ...scope, sessionId: "shared" });
      expect(selected).toEqual(
        listSessionEntriesReadOnly(scope).find(({ entry }) => entry.sessionId === "shared"),
      );
      expect(selected).toMatchObject({
        sessionKey: "agent:main:a-shared",
        entry: { sessionId: "shared", label: "a-shared", spawnDepth: 2 },
      });
      expect(selected?.entry.skillsSnapshot?.prompt).toBe(
        projection === "full" ? "saved prompt" : undefined,
      );
      expect(loadSessionEntryByIdReadOnly({ ...scope, sessionId: "current" })).toMatchObject({
        sessionKey: "agent:main:rolled-over",
        entry: { sessionId: "current" },
      });
      for (const sessionId of ["previous", "retained", "hidden", "missing"]) {
        expect(loadSessionEntryByIdReadOnly({ ...scope, sessionId })).toBeUndefined();
      }
    },
  );

  it("uses the current-ID index without a trimmed fallback on an exact hit", () => {
    const env = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-session-by-id-index-") };
    const scope = { agentId: "main", env };
    runOpenClawAgentWriteTransaction(() => {
      for (let index = 0; index < 32; index += 1) {
        replaceSessionEntrySync(
          { ...scope, sessionKey: `agent:main:entry-${index}` },
          { sessionId: `id-${index}`, updatedAt: 1 },
        );
      }
    }, scope);
    replaceSessionEntrySync(
      { ...scope, sessionKey: "agent:main:a-padded" },
      { sessionId: " id-17 ", updatedAt: 1 },
    );
    const queries = vi.spyOn(sqliteQueries, "iterateSqliteQuerySync");
    try {
      expect(
        loadSessionEntryByIdReadOnly({ ...scope, sessionId: "id-17", projection: "list" }),
      ).toMatchObject({ sessionKey: "agent:main:entry-17" });
      const idQueries = queries.mock.calls
        .map(([database, query]) => ({ database, ...query.compile() }))
        .filter(({ sql }) => /where "current_session_id" = /u.test(sql));
      expect(idQueries).toHaveLength(1);
      expect(queries.mock.calls.some(([, query]) => /trim\(/u.test(query.compile().sql))).toBe(
        false,
      );
      const query = idQueries[0]!;
      const parameters = query.parameters.map((parameter) => {
        if (typeof parameter !== "string") {
          throw new Error("Expected a string session-ID query binding");
        }
        return parameter;
      });
      const plan = query.database
        .prepare(`EXPLAIN QUERY PLAN ${query.sql}`)
        .all(...parameters)
        .map(({ detail }) => detail);
      expect(plan).toContainEqual(
        expect.stringMatching(/\bSEARCH\b.*\bidx_agent_session_nodes_current_session_id\b/u),
      );
      expect(plan).not.toContainEqual(expect.stringMatching(/\bSCAN session_nodes\b/u));
    } finally {
      queries.mockRestore();
    }
  });

  it("runs a trimmed query only after an exact miss and preserves visible match order", () => {
    const env = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-session-by-id-padded-") };
    const scope = { agentId: "main", env, projection: "list" as const };
    for (const name of ["z-padded", "a-padded", "internal-session-effects:padded"]) {
      replaceSessionEntrySync(
        { ...scope, sessionKey: `agent:main:${name}` },
        { sessionId: " \t\u00a0legacy-id\ufeff\r\n", updatedAt: 1, spawnDepth: 2 },
      );
    }
    const queries = vi.spyOn(sqliteQueries, "iterateSqliteQuerySync");
    expect(loadSessionEntryByIdReadOnly({ ...scope, sessionId: "legacy-id" })).toMatchObject({
      sessionKey: "agent:main:a-padded",
      entry: { spawnDepth: 2 },
    });
    const idQueries = queries.mock.calls
      .map(([, query]) => query.compile())
      .filter(({ sql }) => /where (?:"current_session_id"|trim\()/u.test(sql));
    expect(idQueries).toHaveLength(2);
    expect(idQueries[0]?.sql).toMatch(/where "current_session_id" = /u);
    expect(idQueries[1]?.sql).toMatch(/where trim\("current_session_id", /u);
  });

  it("validates a selected row again after a warm read", () => {
    const env = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-session-by-id-invalid-") };
    const scope = { agentId: "main", env, sessionKey: "agent:main:invalid" };
    replaceSessionEntrySync(scope, { sessionId: "selected", updatedAt: 1 });
    expect(loadSessionEntryByIdReadOnly({ ...scope, sessionId: "selected" })).toBeDefined();
    const database = openOpenClawAgentDatabase(scope);
    database.db
      .prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?")
      .run(JSON.stringify({ sessionId: "different", updatedAt: 1 }), scope.sessionKey);
    expect(() => loadSessionEntryByIdReadOnly({ ...scope, sessionId: "selected" })).toThrow(
      "openclaw doctor --fix",
    );
  });

  it("leaves a missing store absent", () => {
    const root = tempDirs.make("openclaw-session-by-id-missing-");
    const env = { OPENCLAW_STATE_DIR: path.join(root, "state") };
    expect(
      loadSessionEntryByIdReadOnly({ agentId: "main", env, sessionId: "missing" }),
    ).toBeUndefined();
    expect(fs.readdirSync(root)).toEqual([]);
  });
});
