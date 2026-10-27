import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { listUsageCountedTranscriptStats } from "../../infra/session-cost-usage-collection.test-support.js";
import { openOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly-open.js";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../runtime-snapshot.js";
import {
  appendTranscriptMessageSync,
  assignSessionOwner,
  cleanupPluginHostSessionStore,
  listSessionEntriesCore,
  listSessionTranscriptInstances,
  loadSessionEntry,
  loadExactSessionEntryReadOnly,
  loadSessionEntryReadOnly,
  loadSessionEntryByIdReadOnly,
  listSessionEntriesReadOnly,
  patchSessionEntryCore,
  persistSessionTranscriptTurn,
  replaceSessionEntrySync,
  upsertSessionEntryCore,
} from "./session-accessor.js";
import {
  readSessionEntryCache,
  readExactSessionEntryCandidatesInDatabase as readCandidates,
} from "./session-accessor.sqlite-entry-cache.js";
import { recordSessionParticipant } from "./session-accessor.sqlite-participants.native.js";
import { readReferencedSessionIds } from "./session-accessor.sqlite-references.js";
import { resolveSqliteTranscriptScope } from "./session-accessor.sqlite-scope.js";
import { ensureTranscriptSessionRoot } from "./session-accessor.sqlite-transcript-state.js";
import { appendTranscriptEventsInTransaction as appendEvents } from "./session-accessor.sqlite-transcript-store.js";
import { appendTranscriptEventSync } from "./session-accessor.sqlite-transcript-write.test-support.js";
import { markCanonicalSessionValidationPending } from "./session-canonical-key.js";
import { promptReport } from "./system-prompt-report.test-support.js";
import type { SessionEntry } from "./types.js";

const parseSessionEntryCalls = vi.hoisted(() => vi.fn());
vi.mock("./session-accessor.sqlite-status.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session-accessor.sqlite-status.js")>();
  return {
    ...actual,
    parseSessionEntryJson: (...args: Parameters<typeof actual.parseSessionEntryJson>) => {
      if (args[1] === "list") {
        parseSessionEntryCalls(args[0].entry_json);
      }
      return actual.parseSessionEntryJson(...args);
    },
  };
});

const sessionDirs = useSessionStoreTempDirs(
  (cleanup) =>
    afterEach(async () => {
      vi.restoreAllMocks();
      await cleanup();
      vi.unstubAllEnvs();
      clearRuntimeConfigSnapshot();
    }),
  "openclaw-entry-cache-",
);

beforeEach(() => {
  parseSessionEntryCalls.mockClear();
  setRuntimeConfigSnapshot({});
});

function createSessionScope(label: string, sessionKey = `agent:main:${label}`) {
  const stateDir = sessionDirs.make();
  return {
    agentId: "main",
    env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    sessionKey,
    projection: "list" as const,
  };
}

type SessionScope = ReturnType<typeof createSessionScope>;

function sessionEntry(sessionId: string, label = sessionId, updatedAt = 1): SessionEntry {
  return { sessionId, label, updatedAt };
}

async function seed(label: string, overrides: Partial<SessionEntry> = {}) {
  const scope = createSessionScope(label);
  await upsertSessionEntryCore(scope, { ...sessionEntry(label), ...overrides });
  return scope;
}

function insertRaw(db: DatabaseSync, sessionKey: string, value: SessionEntry) {
  db.prepare(
    "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at) VALUES (?, ?, ?, ?)",
  ).run(sessionKey, value.sessionId, JSON.stringify(value), value.updatedAt);
}

function expectSmallListPayloads() {
  expect(parseSessionEntryCalls.mock.calls.every(([json]) => Buffer.byteLength(json) < 1024)).toBe(
    true,
  );
}

function expectCached<T>(read: () => T, previous: T) {
  parseSessionEntryCalls.mockClear();
  expect(read()).toBe(previous);
  expect(parseSessionEntryCalls).not.toHaveBeenCalled();
}

function listingEntries(scope: SessionScope, clone = false) {
  return new Map(
    listSessionEntriesCore({ ...scope, clone }).map(({ sessionKey, entry }) => [sessionKey, entry]),
  );
}

function listedEntry(scope: SessionScope) {
  return listSessionEntriesCore({ ...scope, clone: false })[0]?.entry;
}

function savedPrompts(prompt: string, promptChars = 0) {
  return {
    skillsSnapshot: { prompt, skills: [] },
    systemPromptReport: promptReport(1, 1, promptChars),
  };
}

it("reopens pre-device-folder entries through the codec, full accessor, and list cache", async () => {
  const scope = createSessionScope("pre-device-folder");
  const previousEntry: SessionEntry = {
    sessionId: "previous-session",
    label: "Existing local session",
    updatedAt: 123,
    worktree: { id: "previous-worktree", branch: "main", repoRoot: "/repo" },
    modelOverride: "previous-model",
  };
  const database = openOpenClawAgentDatabase(scope);
  // Persist the previous writer's shape, not a current upsert that could add defaults.
  insertRaw(requireNativeSqliteDatabase(database.db), scope.sessionKey, previousEntry);
  await closeOpenClawAgentDatabasesAsync(scope.env.OPENCLAW_STATE_DIR);
  parseSessionEntryCalls.mockClear();

  const full = loadSessionEntry(scope);
  expect(full).toMatchObject(previousEntry);
  expect(full?.deviceFolder).toBeUndefined();
  const listed = listingEntries(scope).get(scope.sessionKey);
  expect(listed).toMatchObject({
    sessionId: previousEntry.sessionId,
    label: previousEntry.label,
    worktree: previousEntry.worktree,
  });
  expect([listed?.deviceFolder, listed?.skillsSnapshot]).toEqual([undefined, undefined]);
  expect(parseSessionEntryCalls).toHaveBeenCalled();
  expectCached(() => listingEntries(scope).get(scope.sessionKey), listed);
  expect(loadExactSessionEntryReadOnly({ ...scope, clone: false })?.entry).toEqual(listed);

  await upsertSessionEntryCore(scope, { ...full!, label: "Continued after upgrade" });
  await closeOpenClawAgentDatabasesAsync(scope.env.OPENCLAW_STATE_DIR);
  const continued = loadSessionEntry(scope);
  expect(continued).toMatchObject({
    ...previousEntry,
    label: "Continued after upgrade",
    updatedAt: expect.any(Number),
  });
  expect(continued!.updatedAt).toBeGreaterThanOrEqual(previousEntry.updatedAt);
  expect(continued?.deviceFolder).toBeUndefined();
});
it("reads retained candidate windows freshly and honors owner exclusions", () => {
  const scope = createSessionScope("reference-window-candidates");
  const database = openOpenClawAgentDatabase(scope);
  insertRaw(requireNativeSqliteDatabase(database.db), scope.sessionKey, {
    sessionId: "current",
    updatedAt: 1,
  });
  readReferencedSessionIds(database);
  const ids = Array.from({ length: 1201 }, (_, index) => `history-${index}`);
  runOpenClawAgentWriteTransaction((current) => {
    current.db
      .prepare("UPDATE session_nodes SET archived_at = 1 WHERE session_key = ?")
      .run(scope.sessionKey);
    const insert = current.db.prepare(
      "INSERT INTO session_windows (session_id, session_key, created_at, updated_at) VALUES (?, ?, 1, 1)",
    );
    for (const id of ids) {
      insert.run(id, scope.sessionKey);
    }
    for (const candidates of [ids.slice(1), ids.slice(0, 1)]) {
      expect(readReferencedSessionIds(current, undefined, candidates)).toEqual(new Set(candidates));
    }
    expect(readReferencedSessionIds(current, new Set([scope.sessionKey]), ids)).toEqual(new Set());
  }, scope);
  expect(readReferencedSessionIds(database)).toEqual(new Set(["current", ...ids]));
  database.db
    .prepare("UPDATE session_nodes SET archived_at = NULL WHERE session_key = ?")
    .run(scope.sessionKey);
  expect(readReferencedSessionIds(database, undefined, ids)).toEqual(new Set());
  expect(readReferencedSessionIds(database, undefined, ids.slice(0, 1))).toEqual(new Set());
});
it.each(["owner", "participant"] as const)(
  "does not decode cold session entries for %s publication",
  async (kind) => {
    const scope = await seed(`cold-${kind}`, {
      skillsSnapshot: { prompt: "stored prompt".repeat(4096), skills: [] },
    });
    parseSessionEntryCalls.mockClear();
    const actor = { type: "agent" as const, id: "research" };
    if (kind === "owner") {
      expect(assignSessionOwner(scope, { owner: actor, assignedBy: actor })).not.toBeNull();
    } else {
      expect(recordSessionParticipant(scope, { identity: actor })).toBe("inserted");
    }
    expect(parseSessionEntryCalls).not.toHaveBeenCalled();
    const entry = listSessionEntriesCore(scope)[0]?.entry;
    expect(entry).toMatchObject(
      kind === "owner"
        ? { owner: { actor } }
        : { participantCount: 1, participants: [{ identity: actor }] },
    );
    expect(entry).not.toHaveProperty("skillsSnapshot");
  },
);

it.each(["plugin-owned-state", "promoted-slots"] as const)(
  "cleans selected plugin metadata while preserving siblings and saved prompts (%s)",
  async (mode) => {
    const scope = createSessionScope("plugin-cleanup");
    vi.stubEnv("OPENCLAW_STATE_DIR", scope.env.OPENCLAW_STATE_DIR);
    const siblingScope = { ...scope, sessionKey: "agent:main:plugin-cleanup-sibling" };
    const prompts = savedPrompts("unneeded cleanup prompt".repeat(4096));
    const entry = {
      sessionId: "plugin-cleanup",
      updatedAt: 1,
      ...prompts,
      pluginExtensions: { fixture: { state: { active: true } } },
      pluginExtensionSlotKeys: { fixture: { state: "fixtureState" } },
      fixtureState: { active: true },
    };
    await upsertSessionEntryCore(scope, entry);
    await upsertSessionEntryCore(siblingScope, { ...entry, sessionId: "plugin-cleanup-sibling" });
    const siblingBefore = loadSessionEntry(siblingScope);
    expect(siblingBefore).toBeDefined();
    const database = openOpenClawAgentDatabase(scope);

    parseSessionEntryCalls.mockClear();
    expect(
      await cleanupPluginHostSessionStore({
        agentId: scope.agentId,
        storePath: database.path,
        sessionKey: scope.sessionKey,
        pluginId: "fixture",
        sessionEntrySlotKeys: new Set(["fixtureState"]),
        mode,
      }),
    ).toBe(1);
    expectSmallListPayloads();
    const cleaned = loadSessionEntry(scope);
    expect(cleaned).toEqual(expect.objectContaining(prompts));
    expect(cleaned).not.toHaveProperty("fixtureState");
    expect(cleaned?.pluginExtensions).toEqual(
      mode === "promoted-slots" ? entry.pluginExtensions : undefined,
    );
    expect(loadSessionEntry(siblingScope)).toEqual(siblingBefore);
  },
);

it("omits saved prompts from usage inventory while preserving full transcript reads", async () => {
  const scope = createSessionScope("usage-inventory");
  const sessionId = "usage-inventory";
  const prompts = savedPrompts("unused usage snapshot α🦞".repeat(4096));
  const worktree = { id: "usage-worktree", branch: "main", repoRoot: "/repo" };
  const deviceFolder = { deviceId: "device-one", path: "/home/example/project" };
  await upsertSessionEntryCore(scope, {
    ...sessionEntry(sessionId),
    ...prompts,
    worktree,
    deviceFolder,
  });
  const event = { type: "session", id: sessionId };
  expect(appendTranscriptEventSync({ ...scope, sessionId }, event).ok).toBe(true);
  const database = openOpenClawAgentDatabase(scope);
  const inventoryParams = { storePath: database.path, sessionsDir: path.dirname(database.path) };

  parseSessionEntryCalls.mockClear();
  const inventory = await listUsageCountedTranscriptStats(scope.agentId, inventoryParams);
  expect(inventory).toEqual([
    expect.objectContaining({
      sessionId,
      kind: "sqlite",
      size: Buffer.byteLength(JSON.stringify(event)),
      eventCount: 1,
      maxSeq: 0,
    }),
  ]);
  expect(parseSessionEntryCalls).toHaveBeenCalledOnce();
  expectSmallListPayloads();
  expect(await listUsageCountedTranscriptStats(scope.agentId, inventoryParams)).toEqual(inventory);

  const fullScope = { agentId: scope.agentId, env: scope.env };
  for (const options of [{}, { sessionId }]) {
    const full = listSessionTranscriptInstances(fullScope, options)[0];
    const listed = listSessionTranscriptInstances(scope, options)[0];
    expect(full?.entry).toEqual(expect.objectContaining(prompts));
    expect(listed).toEqual({
      ...full,
      entry: { ...full?.entry, skillsSnapshot: undefined, systemPromptReport: undefined },
    });
    expect(listed?.entry.worktree).not.toBe(full?.entry.worktree);
    listed!.entry.worktree!.branch = "changed by reader";
    listed!.entry.deviceFolder!.path = "/mutated-copy";
    expect(listSessionTranscriptInstances(scope, options)[0]?.entry).toEqual(
      expect.objectContaining({ worktree, deviceFolder }),
    );
  }
});

it("keeps same-path caches isolated by live connection", async () => {
  const scope = await seed("connection-identity");
  const primary = openOpenClawAgentDatabase(scope);
  const first = listedEntry(scope);
  const opened = openOpenClawAgentDatabaseReadOnly(scope);
  if (!opened.found) {
    throw new Error("Expected the existing agent database");
  }
  const alternate = opened.database.db;
  const parse = vi.spyOn(JSON, "parse");
  const expectOneParse = () =>
    expect(
      parse.mock.calls.filter(([json]) => json.includes('"sessionId":"connection-identity"')),
    ).toHaveLength(1);
  try {
    parseSessionEntryCalls.mockClear();
    const alternateDatabase = { agentId: primary.agentId, db: alternate };
    const alternateEntry = readSessionEntryCache(alternateDatabase, { cache: true }).entries.get(
      scope.sessionKey,
    );
    expect(alternateEntry?.label).toBe("connection-identity");
    expect(alternateEntry).not.toBe(first);
    expectOneParse();

    expectCached(() => listedEntry(scope), first);
    expectCached(
      () => readSessionEntryCache(alternateDatabase, { cache: true }).entries.get(scope.sessionKey),
      alternateEntry,
    );
    expectOneParse();
  } finally {
    parse.mockRestore();
    opened.database.close();
  }
});

it("does not revalidate session nodes after a same-connection transcript write", async () => {
  const scope = await seed("transcript-write", sessionEntry("first", "before"));
  const sibling = { ...scope, sessionKey: `${scope.sessionKey}-sibling` };
  await upsertSessionEntryCore(sibling, sessionEntry("second", "sibling"));
  // Seed maintenance must settle before measuring a same-connection cache write.
  await closeOpenClawAgentDatabasesAsync(scope.env.OPENCLAW_STATE_DIR);
  openOpenClawAgentDatabase(scope);
  const first = listingEntries(scope);

  expect(
    appendTranscriptMessageSync(
      { ...scope, sessionId: "first" },
      { message: { role: "user", content: [{ type: "text", text: "cache probe" }] }, now: 2 },
    ),
  ).toMatchObject({ ok: true, value: { appended: true } });
  parseSessionEntryCalls.mockClear();

  const second = listingEntries(scope);

  expect(second.get(scope.sessionKey)).toBe(first.get(scope.sessionKey));
  expect(second.get(sibling.sessionKey)).toBe(first.get(sibling.sessionKey));
  expect(parseSessionEntryCalls).not.toHaveBeenCalled();
});

it("adds a native insertion to a warm snapshot preserving borrowed siblings", async () => {
  const scope = await seed("write-through-insert");
  openOpenClawAgentDatabase(scope);
  const existing = listingEntries(scope).get(scope.sessionKey);
  const inserted = { ...scope, sessionKey: "agent:main:inserted" };
  replaceSessionEntrySync(inserted, sessionEntry("inserted", "new", 2));
  parseSessionEntryCalls.mockClear();
  const after = listingEntries(scope);
  expect([...after.keys()]).toEqual([scope.sessionKey, inserted.sessionKey].toSorted());
  expect(after.get(scope.sessionKey)).toBe(existing);
  expect(parseSessionEntryCalls).not.toHaveBeenCalled();
});

it("rejects a transcript write after its persisted owner changes", async () => {
  const sessionId = "owned-transcript-session";
  const scope = await seed("transcript-owner-conflict", { sessionId });

  expect(() =>
    runOpenClawAgentWriteTransaction((database) => {
      ensureTranscriptSessionRoot(
        database,
        { ...scope, sessionId, sessionKey: "agent:main:stale-owner" },
        2,
      );
    }, scope),
  ).toThrow("resolve the transcript target again before retrying");

  const database = openOpenClawAgentDatabase(scope);
  expect(
    database.db
      .prepare("SELECT session_key, entry_valid FROM session_nodes ORDER BY session_key")
      .all(),
  ).toEqual([{ session_key: scope.sessionKey, entry_valid: 1 }]);
  expect(
    database.db
      .prepare("SELECT session_key FROM session_windows WHERE session_id = ?")
      .get(sessionId),
  ).toEqual({ session_key: scope.sessionKey });
});

it("bypasses the cache in a transaction and reuses the persisted snapshot after rollback", async () => {
  const scope = await seed("transaction-rollback", sessionEntry("rollback", "before"));
  expect(loadSessionEntry(scope)?.label).toBe("before");
  const borrowedBefore = listedEntry(scope)!;
  expect(borrowedBefore.label).toBe("before");

  expect(() =>
    runOpenClawAgentWriteTransaction((database) => {
      database.db
        .prepare("UPDATE session_nodes SET entry_json = ?, updated_at = 2 WHERE session_key = ?")
        .run(
          JSON.stringify({ ...borrowedBefore, label: "uncommitted", updatedAt: 2 }),
          scope.sessionKey,
        );
      expect(loadSessionEntry({ ...scope, clone: false })?.label).toBe("uncommitted");
      throw new Error("roll back cache probe");
    }, scope),
  ).toThrow("roll back cache probe");

  parseSessionEntryCalls.mockClear();
  const borrowedAfter = listedEntry(scope);
  expect(borrowedAfter).toStrictEqual(borrowedBefore);
  expect(borrowedAfter?.label).toBe("before");
  expect(parseSessionEntryCalls).toHaveBeenCalledTimes(1);
  expectCached(() => listedEntry(scope), borrowedAfter);
});

function createFixture(sessionKey = "agent:main:plain") {
  const scope = createSessionScope("canonical", sessionKey);
  const put = (key: string, entry: Partial<SessionEntry> = {}) =>
    replaceSessionEntrySync(
      { ...scope, sessionKey: key },
      { sessionId: key, updatedAt: 1, ...entry },
    );
  return {
    scope,
    put,
    read: (projection?: "full" | "list", key = sessionKey) =>
      loadSessionEntryReadOnly({ ...scope, sessionKey: key, projection }),
    byId: (sessionId: string) =>
      loadSessionEntryByIdReadOnly({ ...scope, sessionId, projection: "list" }),
    setJson: (key: string, json: string) =>
      openOpenClawAgentDatabase(scope)
        .db.prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?")
        .run(json, key),
    retain: (sessionId: string) =>
      runOpenClawAgentWriteTransaction(
        (database) =>
          ensureTranscriptSessionRoot(
            database,
            { ...scope, sessionKey: `agent:main:${sessionId}`, sessionId },
            1,
          ),
        scope,
      ),
  };
}

it("omits saved prompts from metadata reads and transcript batches", async () => {
  const { scope, put, read } = createFixture();
  const { sessionKey } = scope;
  expect(read("list")).toBeUndefined();
  expect(fs.existsSync(resolveOpenClawAgentSqlitePath(scope))).toBe(false);
  const savedPrompt = "saved prompt ".repeat(40_000);
  put(sessionKey, {
    lifecycleRevision: "original",
    ...savedPrompts(savedPrompt, 1),
  });
  assignSessionOwner(scope, {
    owner: { type: "agent", id: "owner" },
    assignedBy: { type: "human", id: "assigner" },
    assignedAt: 10,
  });
  recordSessionParticipant(scope, { identity: { type: "profile", id: "person" }, promptedAt: 10 });
  const { skillsSnapshot: _saved, systemPromptReport: _report, ...expected } = read()!;
  const queries = trackSqliteStatementExecutions(
    requireNativeSqliteDatabase(openOpenClawAgentDatabase(scope).db),
    ["entries"],
    (sql) => (/(?:from|join)\s+"session_nodes"/i.test(sql) ? "entries" : null),
  );
  using _ = { [Symbol.dispose]: queries.restore };
  expect(read("list")).toEqual(expected);
  expect(queries.textBytes.entries).toBeLessThan(2048);
  queries.textBytes.entries = 0;
  queries.counts.entries = 0;
  runOpenClawAgentWriteTransaction((writer) => {
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
  await patchSessionEntryCore(scope, (entry) => {
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
  const database = openOpenClawAgentDatabase(scope);
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
    expect(() => listSessionEntriesReadOnly({ ...listing, projection })).toThrow(
      "non-canonical persisted row",
    );
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
    listSessionEntriesReadOnly({ ...scope, projection: "list" }).find(
      ({ entry }) => entry.sessionId === "shared",
    ),
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
  const root = sessionDirs.make();
  const env = { OPENCLAW_STATE_DIR: path.join(root, "state") };
  expect(
    loadSessionEntryByIdReadOnly({ agentId: "main", env, sessionId: "missing" }),
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
  const database = openOpenClawAgentDatabase(scope);
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
