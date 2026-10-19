import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import * as agentDb from "../../state/openclaw-agent-db.js";
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../runtime-snapshot.js";
import * as sessions from "./session-accessor.js";
import { readExactSessionEntryCandidatesInDatabase as readCandidates } from "./session-accessor.sqlite-entry-cache.js";
import { recordSessionParticipant } from "./session-accessor.sqlite-participants.native.js";
import { resolveSqliteTranscriptScope } from "./session-accessor.sqlite-scope.js";
import { ensureTranscriptSessionRoot as ensureRoot } from "./session-accessor.sqlite-transcript-state.js";
import { appendTranscriptEventsInTransaction as appendEvents } from "./session-accessor.sqlite-transcript-store.js";
import { markCanonicalSessionValidationPending } from "./session-canonical-key.js";
import type { SessionEntry } from "./types.js";

const tempDirs = useSessionStoreTempDirs(
  (cleanup) =>
    afterEach(async () => {
      vi.restoreAllMocks();
      await cleanup();
      clearRuntimeConfigSnapshot();
    }),
  "canonical-metadata-",
);

beforeEach(() => setRuntimeConfigSnapshot({}));

function createFixture(
  sessionKey = "agent:main:plain",
  env: NodeJS.ProcessEnv = { OPENCLAW_STATE_DIR: tempDirs.make() },
) {
  const scope = { agentId: "main", env, sessionKey };
  const put = (key: string, entry: Partial<SessionEntry> = {}) =>
    sessions.replaceSessionEntrySync(
      { ...scope, sessionKey: key },
      { sessionId: key, updatedAt: 1, ...entry },
    );
  return {
    scope,
    put,
    read: (projection?: "full" | "list", key = sessionKey) =>
      sessions.loadSessionEntryReadOnly({ ...scope, sessionKey: key, projection }),
    byId: (sessionId: string) =>
      sessions.loadSessionEntryByIdReadOnly({ ...scope, sessionId, projection: "list" }),
    setJson: (key: string, json: string) =>
      agentDb
        .openOpenClawAgentDatabase(scope)
        .db.prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?")
        .run(json, key),
    retain: (sessionId: string) =>
      agentDb.runOpenClawAgentWriteTransaction(
        (database) =>
          ensureRoot(database, { ...scope, sessionKey: `agent:main:${sessionId}`, sessionId }, 1),
        scope,
      ),
  };
}

it("omits saved prompts from metadata reads and transcript batches", async () => {
  const { scope, put, read } = createFixture();
  const { sessionKey } = scope;
  expect(read("list")).toBeUndefined();
  expect(fs.existsSync(agentDb.resolveOpenClawAgentSqlitePath(scope))).toBe(false);
  const savedPrompt = "saved prompt ".repeat(40_000);
  put(sessionKey, {
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
  });
  sessions.assignSessionOwner(scope, {
    owner: { type: "agent", id: "owner" },
    assignedBy: { type: "human", id: "assigner" },
    assignedAt: 10,
  });
  recordSessionParticipant(scope, { identity: { type: "profile", id: "person" }, promptedAt: 10 });
  const { skillsSnapshot: _saved, systemPromptReport: _report, ...expected } = read()!;
  const queries = trackSqliteStatementExecutions(
    requireNativeSqliteDatabase(agentDb.openOpenClawAgentDatabase(scope).db),
    ["entries"],
    (sql) => (/(?:from|join)\s+"session_nodes"/i.test(sql) ? "entries" : null),
  );
  using _ = { [Symbol.dispose]: queries.restore };
  expect(read("list")).toEqual(expected);
  expect(queries.textBytes.entries).toBeLessThan(2048);
  queries.textBytes.entries = 0;
  queries.counts.entries = 0;
  agentDb.runOpenClawAgentWriteTransaction((writer) => {
    expect(
      appendEvents(writer, resolveSqliteTranscriptScope({ ...scope, sessionId: sessionKey }), [
        { type: "custom", id: "first", parentId: null, data: "synthetic" },
        { type: "custom", id: "second", parentId: "first", data: "synthetic" },
      ]),
    ).toBe(2);
  }, scope);
  expect(queries.counts.entries).toBeGreaterThan(0);
  expect(queries.textBytes.entries).toBeLessThan(4096);
  expect(read()?.skillsSnapshot?.prompt).toBe(savedPrompt);
  expect(read(undefined, sessionKey.replace("agent:", "AGENT:"))).toEqual(read());
  await sessions.patchSessionEntryCore(scope, (entry) => {
    expect(entry.skillsSnapshot?.prompt).toBe(savedPrompt);
    return { label: "renamed" };
  });
  expect(read()).toMatchObject({ label: "renamed", skillsSnapshot: { prompt: savedPrompt } });
});

it("validates a folded sibling before selecting or preparing the exact opaque target", async () => {
  const sessionKey = "agent:main:matrix:channel:!Mixed:example.org";
  const { scope, put, read, setJson } = createFixture(sessionKey);
  const sibling = sessionKey.toLowerCase();
  [sessionKey, sibling].forEach((key) => put(key));
  read();
  const database = agentDb.openOpenClawAgentDatabase(scope);
  markCanonicalSessionValidationPending(database, [sibling]);
  const delivery = normalizeSessionDeliveryState({
    context: { channel: "matrix", to: "!Mixed:example.org" },
  });
  setJson(sibling, JSON.stringify({ sessionId: sibling, updatedAt: 1, delivery }));
  database.db
    .prepare("UPDATE session_nodes SET entry_valid = 1 WHERE session_key = ?")
    .run(sibling);
  const listing = { ...scope, sessionKeys: [sessionKey], includeParticipants: false };
  for (const projection of ["full", "list"] as const) {
    expect(() => read(projection)).toThrow("non-canonical persisted row");
    expect(() => sessions.listSessionEntriesReadOnly({ ...listing, projection })).toThrow(
      "non-canonical persisted row",
    );
  }
  const shouldAppend = vi.fn(() => true);
  await expect(
    sessions.persistSessionTranscriptTurn(
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
it("preserves visible listing order and excludes retained generations", () => {
  const { scope, put, byId, retain } = createFixture();
  const shared = { sessionId: "shared", spawnDepth: 2 };
  for (const name of ["z-shared", "a-shared", "internal-session-effects:shared"]) {
    put(`agent:main:${name}`, {
      ...shared,
      label: name,
      skillsSnapshot: { prompt: "saved prompt", skills: [] },
    });
  }
  put("agent:main:internal-session-effects:hidden", { sessionId: "hidden" });
  ["previous", "current"].forEach((sessionId) => put("agent:main:rolled-over", { sessionId }));
  retain("retained");

  const selected = byId("shared");
  expect(selected).toEqual(
    sessions
      .listSessionEntriesReadOnly({ ...scope, projection: "list" })
      .find(({ entry }) => entry.sessionId === "shared"),
  );
  expect(selected).toMatchObject({
    sessionKey: "agent:main:a-shared",
    entry: { ...shared, label: "a-shared" },
  });
  expect(selected?.entry.skillsSnapshot).toBeUndefined();
  expect(byId("current")).toMatchObject({
    sessionKey: "agent:main:rolled-over",
    entry: { sessionId: "current" },
  });
  ["previous", "retained", "hidden", "missing"].forEach((id) => expect(byId(id)).toBeUndefined());
});

it("leaves a missing store absent", () => {
  const root = tempDirs.make();
  const env = { OPENCLAW_STATE_DIR: path.join(root, "state") };
  expect(
    sessions.loadSessionEntryByIdReadOnly({ agentId: "main", env, sessionId: "missing" }),
  ).toBeUndefined();
  expect(fs.readdirSync(root)).toEqual([]);
});

it("preserves delivery JSON semantics, retained windows, and invalid-row failures", () => {
  const { scope, put, retain, setJson } = createFixture();
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
    json,
    json
      .replace('"sessionId":"source"', '"sessionId":"discarded","sessionId":"source"')
      .replace('"delivery":', '"delivery":null,"delivery":'),
    json.slice(0, -1) + ',"unused":' + "[".repeat(1100) + "0" + "]".repeat(1100) + "}",
    JSON.stringify({ ...entry, delivery: null, groupId: false }),
    JSON.stringify({ ...entry, groupId: "opaque-\ud800" }),
    '{"sessionId":"source","updatedAt":1}',
  ];
  const database = agentDb.openOpenClawAgentDatabase(scope);
  const keys = cases.map((_, index) => `agent:main:case-${index}`);
  keys.forEach((key) => put(key, entry));
  retain("retained");
  keys.push("agent:main:retained", "agent:main:missing");
  const read = (projection: "list" | "delivery") =>
    readCandidates(
      database,
      keys.map((key) => [key]),
      projection,
    );
  expect(read("delivery").every((result) => result.ok)).toBe(true);
  // Admitted readers preserve raw metadata parsing; cold admission still rejects uncertified rows.
  cases.forEach((stored, index) => setJson(keys[index]!, stored));
  expect(read("delivery")).toEqual([
    ...cases.map((stored, index) => {
      const projected: Record<string, unknown> = JSON.parse(stored);
      delete projected.unused;
      return { ok: true, value: [{ sessionKey: keys[index], entry: projected }] };
    }),
    { ok: true, value: [] },
    { ok: true, value: [] },
  ]);
  for (const broken of [
    json + "\u0000tail",
    '{"unrelated":true}',
    json.replace('"updatedAt":1', '"updatedAt":2'),
  ]) {
    setJson(keys[0]!, broken);
    expect(read("delivery").map((r) => r.ok)).toEqual(read("list").map((r) => r.ok));
    expect(read("delivery")[0]).toMatchObject({
      ok: false,
      error: { code: "SESSION_CANONICAL_KEY_MIGRATION_REQUIRED" },
    });
  }
});
