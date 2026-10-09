import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { clearNodeSqliteKyselyCacheForDatabase } from "../../infra/kysely-sync.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import {
  assignSessionOwner,
  listSessionEntriesReadOnly,
  loadSessionEntryByIdReadOnly,
  loadSessionEntryReadOnly,
  patchSessionEntryCore,
  persistSessionTranscriptTurn,
  replaceSessionEntrySync,
} from "./session-accessor.js";
import { loadExactSessionEntryCandidatesReadOnlyBatch } from "./session-accessor.sqlite-exact-read.js";
import { recordSessionParticipant } from "./session-accessor.sqlite-participants.native.js";
import { resolveSqliteTranscriptScope } from "./session-accessor.sqlite-scope.js";
import { ensureTranscriptSessionRoot } from "./session-accessor.sqlite-transcript-state.js";
import { appendTranscriptEventsInTransaction } from "./session-accessor.sqlite-transcript-store.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.restoreAllMocks();
    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawAgentDatabasesForTest();
    await closeStateDatabaseForTest();
    cleanup();
  }),
);

describe("canonical SQLite metadata reads", () => {
  it("omits saved prompts from metadata reads and transcript batches", async () => {
    const sessionKey = "agent:main:plain";
    const env = { OPENCLAW_STATE_DIR: tempDirs.make("canonical-metadata-") };
    const scope = { agentId: "main", env, sessionKey };
    expect(loadSessionEntryReadOnly({ ...scope, projection: "list" })).toBeUndefined();
    expect(fs.existsSync(resolveOpenClawAgentSqlitePath(scope))).toBe(false);
    const savedPrompt = "saved prompt ".repeat(40_000);
    const keys = [...new Set([sessionKey, sessionKey.toLowerCase()])];
    for (const key of keys) {
      replaceSessionEntrySync(
        { ...scope, sessionKey: key },
        {
          sessionId: key,
          updatedAt: 1,
          lifecycleRevision: "original",
          skillsSnapshot: { prompt: savedPrompt, skills: [] },
          systemPromptReport: {
            source: "run",
            generatedAt: 1,
            systemPrompt: { chars: 1, projectContextChars: 0, nonProjectContextChars: 1 },
            injectedWorkspaceFiles: [],
            skills: { promptChars: 1, entries: [] },
            tools: { listChars: 0, schemaChars: 0, entries: [] },
          },
        },
      );
    }
    assignSessionOwner(scope, {
      owner: { type: "agent", id: "owner" },
      assignedBy: { type: "human", id: "assigner" },
      assignedAt: 10,
    });
    recordSessionParticipant(scope, {
      identity: { type: "profile", id: "person" },
      promptedAt: 10,
    });
    const expected = { ...loadSessionEntryReadOnly(scope)! };
    delete expected.skillsSnapshot;
    delete expected.systemPromptReport;
    const database = openOpenClawAgentDatabase(scope);
    const queries = trackSqliteStatementExecutions(database.db, ["entries"], (sql) =>
      /from\s+"session_nodes"/i.test(sql) ? "entries" : null,
    );
    try {
      expect(loadSessionEntryReadOnly({ ...scope, projection: "list" })).toEqual(expected);
      expect(queries.textBytes.entries).toBeLessThan(2048);
      queries.textBytes.entries = 0;
      runOpenClawAgentWriteTransaction((writer) => {
        expect(
          appendTranscriptEventsInTransaction(
            writer,
            resolveSqliteTranscriptScope({ ...scope, sessionId: sessionKey }),
            [
              { type: "custom", id: "first", parentId: null, data: "synthetic" },
              { type: "custom", id: "second", parentId: "first", data: "synthetic" },
            ],
          ),
        ).toBe(2);
      }, scope);
      expect(queries.textBytes.entries).toBeLessThan(4096);
    } finally {
      queries.restore();
    }
    // Ordinary reads and subsequent writes must still own the complete prompt payload.
    expect(loadSessionEntryReadOnly(scope)?.skillsSnapshot?.prompt).toBe(savedPrompt);
    expect(
      loadSessionEntryReadOnly({ ...scope, sessionKey: sessionKey.replace("agent:", "AGENT:") }),
    ).toEqual(loadSessionEntryReadOnly(scope));
    await patchSessionEntryCore(scope, (entry) => {
      expect(entry.skillsSnapshot?.prompt).toBe(savedPrompt);
      return { label: "renamed" };
    });
    expect(loadSessionEntryReadOnly(scope)).toMatchObject({
      label: "renamed",
      skillsSnapshot: { prompt: savedPrompt },
    });
  });

  it("validates a folded sibling before selecting or preparing the exact opaque target", async () => {
    const env = { OPENCLAW_STATE_DIR: tempDirs.make("canonical-metadata-sibling-") };
    const sessionKey = "agent:main:matrix:channel:!Mixed:example.org";
    const scope = { agentId: "main", env, sessionKey };
    const sibling = sessionKey.toLowerCase();
    for (const key of [sessionKey, sibling]) {
      replaceSessionEntrySync({ ...scope, sessionKey: key }, { sessionId: key, updatedAt: 1 });
    }
    loadSessionEntryReadOnly(scope);
    const database = openOpenClawAgentDatabase(scope);
    database.db.prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?").run(
      JSON.stringify({
        sessionId: sibling,
        updatedAt: 1,
        delivery: normalizeSessionDeliveryState({
          context: { channel: "matrix", to: "!Mixed:example.org" },
        }),
      }),
      sibling,
    );
    database.db
      .prepare("UPDATE session_nodes SET entry_valid = 1 WHERE session_key = ?")
      .run(sibling);
    for (const projection of ["full", "list"] as const) {
      expect(() => loadSessionEntryReadOnly({ ...scope, projection })).toThrow(
        "non-canonical persisted row",
      );
      expect(() =>
        listSessionEntriesReadOnly({
          ...scope,
          projection,
          sessionKeys: [sessionKey],
          includeParticipants: false,
        }),
      ).toThrow("non-canonical persisted row");
    }
    const shouldAppend = vi.fn(() => true);
    await expect(
      persistSessionTranscriptTurn(
        { ...scope, sessionId: sessionKey },
        {
          expectedSessionId: sessionKey,
          messages: [{ message: { role: "user", content: "must not prepare" }, shouldAppend }],
          updateMode: "none",
        },
      ),
    ).rejects.toThrow("non-canonical persisted row");
    expect(shouldAppend).not.toHaveBeenCalled();
  });
});

describe("current session ID entry reads", () => {
  it("preserves visible listing order and excludes retained generations", () => {
    const env = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-session-by-id-") };
    const scope = { agentId: "main", env, projection: "list" as const };
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
    expect(selected?.entry.skillsSnapshot).toBeUndefined();
    expect(loadSessionEntryByIdReadOnly({ ...scope, sessionId: "current" })).toMatchObject({
      sessionKey: "agent:main:rolled-over",
      entry: { sessionId: "current" },
    });
    for (const sessionId of ["previous", "retained", "hidden", "missing"]) {
      expect(loadSessionEntryByIdReadOnly({ ...scope, sessionId })).toBeUndefined();
    }
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

it("preserves delivery JSON semantics, retained windows, and invalid-row failures", async () => {
  await withOpenClawTestState({ label: "narrow-delivery" }, async (state) => {
    const scope = { agentId: "main", env: state.env };
    const delivery = normalizeSessionDeliveryState({
      context: {
        channel: "matrix",
        to: "!Opaque:example.org",
        accountId: "work",
        threadId: "Topic",
      },
    });
    const entry = { sessionId: "source", updatedAt: 1, delivery, groupId: "!Opaque:example.org" };
    const json = JSON.stringify(entry);
    const cases = [
      { name: "ordinary", json },
      {
        name: "duplicate",
        json: json
          .replace('"sessionId":"source"', '"sessionId":"discarded","sessionId":"source"')
          .replace('"delivery":', '"delivery":null,"delivery":'),
      },
      {
        name: "deep",
        json: json.slice(0, -1) + ',"unused":' + "[".repeat(1100) + "0" + "]".repeat(1100) + "}",
      },
      { name: "null", json: JSON.stringify({ ...entry, delivery: null, groupId: false }) },
      { name: "escaped", json: JSON.stringify({ ...entry, groupId: "opaque-\ud800" }) },
      { name: "absent", json: '{"sessionId":"source","updatedAt":1}' },
    ];
    const database = openOpenClawAgentDatabase(scope);
    for (const item of cases) {
      const sessionKey = `agent:main:${item.name}`;
      replaceSessionEntrySync({ ...scope, sessionKey }, entry);
    }
    const retained = "agent:main:retained";
    runOpenClawAgentWriteTransaction((db) => {
      ensureTranscriptSessionRoot(db, { ...scope, sessionKey: retained, sessionId: "retained" }, 1);
    }, scope);
    const keys = [...cases.map(({ name }) => `agent:main:${name}`), retained, "agent:main:missing"];
    const read = (projection: "list" | "delivery") =>
      loadExactSessionEntryCandidatesReadOnlyBatch(
        keys.map((key) => ({ ...scope, sessionKeys: [key], projection })),
      );
    expect(read("delivery").every((result) => result.ok)).toBe(true);
    // Admitted readers preserve raw metadata parsing; cold admission still rejects uncertified rows.
    for (const [index, item] of cases.entries()) {
      database.db
        .prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?")
        .run(item.json, keys[index]!);
    }
    expect(read("delivery")).toEqual([
      ...cases.map(({ json: stored }, index) => {
        const { sessionId, updatedAt, delivery: route, groupId } = JSON.parse(stored);
        return {
          ok: true,
          value: [
            {
              sessionKey: keys[index],
              entry: {
                sessionId,
                updatedAt,
                ...(route !== undefined ? { delivery: route } : {}),
                ...(groupId !== undefined ? { groupId } : {}),
              },
            },
          ],
        };
      }),
      { ok: true, value: [] },
      { ok: true, value: [] },
    ]);
    for (const broken of [
      json + "\u0000tail",
      '{"unrelated":true}',
      json.replace('"updatedAt":1', '"updatedAt":2'),
    ]) {
      database.db
        .prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?")
        .run(broken, keys[0]!);
      expect(read("delivery").map((r) => r.ok)).toEqual(read("list").map((r) => r.ok));
      expect(read("delivery")[0]).toMatchObject({
        ok: false,
        error: { code: "SESSION_CANONICAL_KEY_MIGRATION_REQUIRED" },
      });
    }
  });
});

describe("exact SQLite session batch availability", () => {
  it.each(["session_key_contract", "session_nodes"])(
    "preserves table-missing (%s) outcomes for every requested key",
    (table) => {
      const scope = {
        agentId: "main",
        env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-exact-unavailable-") },
      };
      const { db, path: databasePath } = openOpenClawAgentDatabase(scope);
      clearNodeSqliteKyselyCacheForDatabase(db);
      const prepare = db.prepare.bind(db);
      const prepareSpy = vi.spyOn(db, "prepare").mockImplementation((sql) => {
        if (sql.includes(`from "${table}"`)) {
          // Lose the table after schema admission, before reading its metadata.
          prepareSpy.mockRestore();
          db.exec(`DROP TABLE ${table}`);
        }
        return prepare(sql);
      });
      const healthy = {
        agentId: "main",
        env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-exact-available-") },
      };
      openOpenClawAgentDatabase(healthy);
      const results = loadExactSessionEntryCandidatesReadOnlyBatch([
        { ...scope, sessionKeys: ["agent:main:first"] },
        { ...healthy, sessionKeys: ["agent:main:absent"] },
        { ...scope, sessionKeys: ["agent:main:second"] },
      ]);
      const expected = {
        ok: false,
        error: {
          name: "SessionMetadataUnavailableError",
          reason: "table-missing",
          cause: { code: "ERR_SQLITE_ERROR" },
          missingTables: [table],
        },
      };
      expect(results).toMatchObject([expected, { ok: true, value: [] }, expected]);
      expect(fs.existsSync(databasePath)).toBe(true);
    },
  );

  it("keeps a present empty store and an empty key request successful", () => {
    const scope = {
      agentId: "main",
      env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-exact-empty-") },
    };
    openOpenClawAgentDatabase(scope);
    expect(
      loadExactSessionEntryCandidatesReadOnlyBatch([
        { ...scope, sessionKeys: ["agent:main:absent"] },
        { ...scope, sessionKeys: [" "] },
      ]),
    ).toEqual([
      { ok: true, value: [] },
      { ok: true, value: [] },
    ]);
  });
});
