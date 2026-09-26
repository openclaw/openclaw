import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listUsageCountedTranscriptStats } from "../../infra/session-cost-usage-collection.js";
import { configureSqliteConnectionPragmas } from "../../infra/sqlite-wal.js";
import { openOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly-open.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import {
  appendTranscriptEventSync,
  appendTranscriptMessage,
  assignSessionOwner,
  cleanupPluginHostSessionStore,
  listSessionEntriesCore,
  listSessionTranscriptInstances,
  loadSessionEntry,
  openSessionEntryReadView,
  upsertSessionEntryCore,
} from "./session-accessor.js";
import { useSessionEntryCacheFixture } from "./session-accessor.sqlite-data-version.test-support.js";
import { readSessionEntryCache } from "./session-accessor.sqlite-entry-cache.js";
import { captureSessionEntryRead } from "./session-accessor.sqlite-entry-read-lifetime.js";
import {
  readSessionEntryCount,
  iterateSessionEntryKeys,
  writeSessionEntry,
} from "./session-accessor.sqlite-entry-store.js";
import { readReferencedSessionIds } from "./session-accessor.sqlite-lifecycle-state.js";
import { recordSessionParticipant } from "./session-accessor.sqlite-participants.native.js";
import { ensureTranscriptSessionRoot } from "./session-accessor.sqlite-transcript-state.js";

const parseSessionEntryCalls = vi.hoisted(() => vi.fn());
vi.mock("./session-accessor.sqlite-status.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session-accessor.sqlite-status.js")>();
  return {
    ...actual,
    parseSessionEntryJson: (...args: Parameters<typeof actual.parseSessionEntryJson>) => {
      // Snapshot/publication rows omit the current-id column; exact writer CAS reads
      // share this decoder but are outside the cache work measured here.
      if (args[0].current_session_id === undefined) {
        parseSessionEntryCalls(args[0].entry_json);
      }
      return actual.parseSessionEntryJson(...args);
    },
  };
});

const createSessionScope = useSessionEntryCacheFixture();

beforeEach(() => {
  parseSessionEntryCalls.mockClear();
});

describe("exact session entry read lifetimes", () => {
  it("keeps a selected read through sibling writes and full-list expansion", async () => {
    const scope = createSessionScope("selected-read");
    const sibling = { ...scope, sessionKey: "agent:main:unrelated" };
    await upsertSessionEntryCore(scope, { sessionId: "selected", label: "A", updatedAt: 1 });
    await upsertSessionEntryCore(sibling, { sessionId: "other", label: "B", updatedAt: 1 });
    const database = openOpenClawAgentDatabase(scope);
    parseSessionEntryCalls.mockClear();
    const read = captureSessionEntryRead(database, scope.sessionKey);
    try {
      expect(read.entry).toMatchObject({ sessionId: "selected", label: "A" });
      expect(parseSessionEntryCalls).not.toHaveBeenCalled();
      await upsertSessionEntryCore(sibling, { label: "renamed B" });
      expect(read.isCurrent()).toBe(true);
      expect(
        readSessionEntryCache(database, { cache: true }).entries.get(sibling.sessionKey),
      ).toMatchObject({ label: "renamed B" });
      expect(read.isCurrent()).toBe(true);
      await upsertSessionEntryCore(scope, { label: "changed A" });
      expect(read.isCurrent()).toBe(false);
    } finally {
      read.release();
    }
    expect(read.isCurrent()).toBe(false);
  });

  it.each(["same connection", "other connection"])(
    "keeps identical canonical facts current after delete/recreate on %s",
    async (writer) => {
      const scope = createSessionScope("selected-read-aba");
      await upsertSessionEntryCore(scope, { sessionId: "same-id", label: "A", updatedAt: 1 });
      const database = openOpenClawAgentDatabase(scope);
      loadSessionEntry(scope);
      const read = captureSessionEntryRead(database, scope.sessionKey);
      const connection =
        writer === "same connection" ? database.db : new DatabaseSync(database.path);
      try {
        connection.exec("CREATE TEMP TABLE saved_node AS SELECT * FROM session_nodes;");
        connection.prepare("DELETE FROM session_nodes WHERE session_key = ?").run(scope.sessionKey);
        connection.exec("INSERT INTO session_nodes SELECT * FROM saved_node;");
        // Metadata depends on current canonical facts, not whether identical rows were rewritten.
        expect(read.isCurrent()).toBe(true);
        expect(loadSessionEntry(scope)).toMatchObject(read.entry!);
      } finally {
        read.release();
        if (connection !== database.db) {
          connection.close();
        }
      }
    },
  );

  it("keeps concurrent missing-row reads until creation and releases independently", async () => {
    const scope = createSessionScope("selected-missing");
    const database = openOpenClawAgentDatabase(scope);
    const first = captureSessionEntryRead(database, scope.sessionKey);
    const second = captureSessionEntryRead(database, scope.sessionKey);
    try {
      expect(first.entry).toBeUndefined();
      first.release();
      expect(second.isCurrent()).toBe(true);
      await upsertSessionEntryCore(scope, { sessionId: "created", updatedAt: 1 });
      expect(second.isCurrent()).toBe(false);
    } finally {
      first.release();
      second.release();
    }
  });
});

describe("SQLite retained session window references", () => {
  it("reads retained candidate windows freshly and honors owner exclusions", () => {
    const scope = createSessionScope("reference-window-candidates");
    const database = openOpenClawAgentDatabase(scope);
    database.db
      .prepare(
        "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at) VALUES (?, ?, ?, 1)",
      )
      .run(scope.sessionKey, "current", JSON.stringify({ sessionId: "current", updatedAt: 1 }));
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
      expect(readReferencedSessionIds(current, undefined, ids.slice(1))).toEqual(
        new Set(ids.slice(1)),
      );
      expect(readReferencedSessionIds(current, undefined, ids.slice(0, 1))).toEqual(
        new Set(ids.slice(0, 1)),
      );
      expect(readReferencedSessionIds(current, new Set([scope.sessionKey]), ids)).toEqual(
        new Set(),
      );
    }, scope);
    expect(readReferencedSessionIds(database)).toEqual(new Set(["current", ...ids]));
    database.db
      .prepare("UPDATE session_nodes SET archived_at = NULL WHERE session_key = ?")
      .run(scope.sessionKey);
    expect(readReferencedSessionIds(database, undefined, ids)).toEqual(new Set());
    expect(readReferencedSessionIds(database, undefined, ids.slice(0, 1))).toEqual(new Set());
  });
});

describe("SQLite session entry cache", () => {
  it.each(["owner", "participant"] as const)(
    "does not decode cold session entries for %s publication",
    async (kind) => {
      const scope = createSessionScope(`cold-${kind}`);
      await upsertSessionEntryCore(scope, {
        sessionId: `cold-${kind}`,
        updatedAt: 1,
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
          ? { owner: { actor: { type: "agent", id: "research" } } }
          : {
              participantCount: 1,
              participants: [{ identity: { type: "agent", id: "research" } }],
            },
      );
      expect(entry).not.toHaveProperty("skillsSnapshot");
    },
  );

  it.each(["plugin-owned-state", "promoted-slots"] as const)(
    "scans plugin cleanup metadata without decoding saved prompts (%s)",
    async (mode) => {
      const scope = createSessionScope("plugin-cleanup");
      const siblingScope = { ...scope, sessionKey: "agent:main:plugin-cleanup-sibling" };
      const skillsSnapshot = { prompt: "unneeded cleanup prompt".repeat(4096), skills: [] };
      const systemPromptReport = {
        source: "run" as const,
        generatedAt: 1,
        systemPrompt: { chars: 1, projectContextChars: 0, nonProjectContextChars: 1 },
        injectedWorkspaceFiles: [],
        skills: { promptChars: 0, entries: [] },
        tools: { listChars: 0, schemaChars: 0, entries: [] },
      };
      const entry = {
        sessionId: "plugin-cleanup",
        updatedAt: 1,
        skillsSnapshot,
        systemPromptReport,
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
      expect(parseSessionEntryCalls).toHaveBeenCalled();
      expect(
        parseSessionEntryCalls.mock.calls.every(([json]) => Buffer.byteLength(json) < 1024),
      ).toBe(true);
      const cleaned = loadSessionEntry(scope);
      expect(cleaned?.skillsSnapshot).toEqual(skillsSnapshot);
      expect(cleaned?.systemPromptReport).toEqual(systemPromptReport);
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
    const skillsSnapshot = { prompt: "unused usage snapshot α🦞".repeat(4096), skills: [] };
    const worktree = { id: "usage-worktree", branch: "main", repoRoot: "/repo" };
    await upsertSessionEntryCore(scope, { sessionId, updatedAt: 1, skillsSnapshot, worktree });
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
    expect(
      parseSessionEntryCalls.mock.calls.every(([json]) => Buffer.byteLength(json) < 1024),
    ).toBe(true);
    expect(await listUsageCountedTranscriptStats(scope.agentId, inventoryParams)).toEqual(
      inventory,
    );

    const fullScope = { agentId: scope.agentId, env: scope.env };
    for (const options of [{}, { sessionId }]) {
      const full = listSessionTranscriptInstances(fullScope, options)[0];
      const listed = listSessionTranscriptInstances(scope, options)[0];
      expect(full?.entry.skillsSnapshot).toEqual(skillsSnapshot);
      expect(listed).toEqual({ ...full, entry: { ...full?.entry, skillsSnapshot: undefined } });
      expect(listed?.entry.worktree).not.toBe(full?.entry.worktree);
      listed!.entry.worktree!.branch = "changed by reader";
      expect(listSessionTranscriptInstances(scope, options)[0]?.entry.worktree).toEqual(worktree);
    }
  });

  it.each([
    ["malformed", "{", false],
    ["JSON5", '{sessionId:"raw",updatedAt:1}', false],
    ["non-finite identity", '{"sessionId":"raw","updatedAt":1e999}', false],
    ["duplicate identity", '{"sessionId":null,"sessionId":"raw","updatedAt":1}', true],
    [
      "duplicate prompts",
      '{"sessionId":"raw","updatedAt":1,"skillsSnapshot":{},"skillsSnapshot":{"prompt":"last","skills":[]}}',
      true,
    ],
    [
      "deep JSON",
      `{"sessionId":"raw","updatedAt":1,"skillsSnapshot":{"prompt":${"[".repeat(1001)}0${"]".repeat(1001)},"skills":[]}}`,
      true,
    ],
  ])("preserves list parsing for %s rows", (_name, entryJson, readable) => {
    const scope = createSessionScope("raw-list-projection");
    const database = openOpenClawAgentDatabase(scope);
    // Raw runtime writes follow canonical admission; this case isolates subsequent JSON decoding.
    listSessionEntriesCore(scope);
    database.db
      .prepare(
        "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at) VALUES (?, ?, ?, ?)",
      )
      .run(scope.sessionKey, "raw", entryJson, 1);
    const snapshot = readSessionEntryCache(database, { cache: false });
    expect(snapshot.keys).toEqual([scope.sessionKey]);
    expect(snapshot.entries.size).toBe(readable ? 1 : 0);
    expect(readSessionEntryCount(database)).toBe(readable ? 1 : 0);
    expect([...iterateSessionEntryKeys(database)]).toEqual(readable ? [scope.sessionKey] : []);
    expect(snapshot.entries.get(scope.sessionKey)?.skillsSnapshot).toBeUndefined();
  });

  it("retains only listing metadata while full reads preserve saved prompt state", async () => {
    const scope = createSessionScope("lazy-list-projection");
    const prompt = "large skill prompt".repeat(8192);
    await upsertSessionEntryCore(scope, {
      label: "projected",
      sessionId: "lazy-list-projection",
      updatedAt: 1,
      worktree: { id: "worktree-1", branch: "main", repoRoot: "/repo" },
      skillsSnapshot: { prompt, skills: [] },
      systemPromptReport: {
        source: "run",
        generatedAt: 1,
        systemPrompt: { chars: 1, projectContextChars: 0, nonProjectContextChars: 1 },
        injectedWorkspaceFiles: [],
        skills: { promptChars: 0, entries: [] },
        tools: { listChars: 0, schemaChars: 0, entries: [] },
      },
    });

    const cloneSpy = vi.spyOn(globalThis, "structuredClone");
    try {
      const fullEntry = listSessionEntriesCore({
        agentId: scope.agentId,
        env: scope.env,
      })[0]?.entry;
      expect(fullEntry).toBeDefined();
      if (!fullEntry) {
        throw new Error("missing seeded lazy-list-projection entry");
      }
      parseSessionEntryCalls.mockClear();
      const first = listSessionEntriesCore({
        ...scope,
        clone: false,
        projection: "list",
      })[0]?.entry;
      const second = listSessionEntriesCore({
        ...scope,
        clone: false,
        projection: "list",
      })[0]?.entry;

      expect(first).not.toBe(fullEntry);
      expect(first?.worktree).toEqual(fullEntry.worktree);
      expect(first?.skillsSnapshot).toBeUndefined();
      expect(first?.systemPromptReport).toBeUndefined();
      expect(second).toBe(first);
      expect(cloneSpy).not.toHaveBeenCalled();
      expect(parseSessionEntryCalls.mock.calls).toHaveLength(1);
      expect(
        parseSessionEntryCalls.mock.calls.every(([json]) => Buffer.byteLength(json) < 1024),
      ).toBe(true);
      const cached = readSessionEntryCache(openOpenClawAgentDatabase(scope), { cache: true });
      expect(cached.entries.get(scope.sessionKey)).toBe(first);
      expect(cached.entries.get(scope.sessionKey)?.skillsSnapshot).toBeUndefined();
      expect(cached.entries.get(scope.sessionKey)?.systemPromptReport).toBeUndefined();

      fullEntry.worktree!.branch = "mutated full read";
      fullEntry.skillsSnapshot!.prompt = "mutated full prompt";
      const fullAgain = listSessionEntriesCore({ ...scope, projection: "full" })[0]?.entry;
      expect(fullAgain?.worktree?.branch).toBe("main");
      expect(fullAgain?.skillsSnapshot?.prompt).toBe(prompt);
      expect(fullAgain?.systemPromptReport?.source).toBe("run");
      expect(cloneSpy).not.toHaveBeenCalled();
      expect(first?.worktree?.branch).toBe("main");

      const copiedListEntry = listSessionEntriesCore(scope)[0]?.entry;
      expect(copiedListEntry?.worktree?.branch).toBe("main");
      expect(copiedListEntry?.worktree).not.toBe(first?.worktree);
      copiedListEntry!.worktree!.branch = "mutated list copy";
      expect(first?.worktree?.branch).toBe("main");
      expect(listSessionEntriesCore({ ...scope, clone: false, projection: "list" })[0]?.entry).toBe(
        first,
      );
    } finally {
      cloneSpy.mockRestore();
    }
  });

  it("keeps same-path caches isolated by live connection", async () => {
    const scope = createSessionScope("connection-identity");
    await upsertSessionEntryCore(scope, {
      label: "connection-identity",
      sessionId: "connection-identity",
      updatedAt: 1,
    });
    const primary = openOpenClawAgentDatabase(scope);
    const first = listSessionEntriesCore({ ...scope, clone: false });
    const opened = openOpenClawAgentDatabaseReadOnly(scope);
    if (!opened.found) {
      throw new Error("Expected the existing agent database");
    }
    const alternate = opened.database.db;
    const parse = vi.spyOn(JSON, "parse");

    try {
      parseSessionEntryCalls.mockClear();
      const alternateSnapshot = readSessionEntryCache(
        { agentId: primary.agentId, db: alternate },
        { cache: true },
      );
      expect(alternateSnapshot.entries.get(scope.sessionKey)?.label).toBe("connection-identity");
      const alternateEntry = alternateSnapshot.entries.get(scope.sessionKey);
      expect(
        parse.mock.calls.filter(([json]) => json.includes('"sessionId":"connection-identity"')),
      ).toHaveLength(1);

      parseSessionEntryCalls.mockClear();
      const second = listSessionEntriesCore({ ...scope, clone: false });

      expect(second[0]?.entry).toBe(first[0]?.entry);
      expect(parseSessionEntryCalls).not.toHaveBeenCalled();

      parseSessionEntryCalls.mockClear();
      const alternateAgain = readSessionEntryCache(
        { agentId: primary.agentId, db: alternate },
        { cache: true },
      );

      expect(alternateAgain.entries.get(scope.sessionKey)).toBe(alternateEntry);
      expect(parseSessionEntryCalls).not.toHaveBeenCalled();
      expect(
        parse.mock.calls.filter(([json]) => json.includes('"sessionId":"connection-identity"')),
      ).toHaveLength(1);
    } finally {
      parse.mockRestore();
      opened.database.close();
    }
  });

  it("does not revalidate session nodes after a same-connection transcript write", async () => {
    const scope = createSessionScope("same-connection-non-entry");
    const siblingScope = { ...scope, sessionKey: "agent:main:same-connection-non-entry-2" };
    await upsertSessionEntryCore(scope, {
      label: "projection-probe-first",
      sessionId: "same-connection-non-entry",
      updatedAt: 1,
    });
    await upsertSessionEntryCore(siblingScope, {
      label: "projection-probe-second",
      sessionId: "same-connection-non-entry-2",
      updatedAt: 1,
    });
    const first = listSessionEntriesCore({ ...scope, clone: false, projection: "list" });

    await appendTranscriptMessage(
      { ...scope, sessionId: "same-connection-non-entry" },
      { message: { role: "user", content: [{ type: "text", text: "cache probe" }] }, now: 2 },
    );
    parseSessionEntryCalls.mockClear();

    const second = listSessionEntriesCore({ ...scope, clone: false, projection: "list" });

    expect(second.map((row) => row.entry)).toEqual(first.map((row) => row.entry));
    expect(second[0]?.entry).toBe(first[0]?.entry);
    expect(second[1]?.entry).toBe(first[1]?.entry);
    expect(parseSessionEntryCalls).not.toHaveBeenCalled();
  });

  it("fully reloads a cross-connection same-millisecond entry rewrite", async () => {
    const scope = createSessionScope("external-same-ms");
    const siblingScope = { ...scope, sessionKey: "agent:main:external-same-ms-sibling" };
    await upsertSessionEntryCore(scope, {
      label: "projection-probe-before",
      sessionId: "external-same-ms",
      updatedAt: 1_000,
    });
    await upsertSessionEntryCore(siblingScope, {
      label: "projection-probe-sibling",
      sessionId: "external-same-ms-sibling",
      updatedAt: 1_000,
    });
    const before = listSessionEntriesCore({ ...scope, clone: false, projection: "list" })[0]?.entry;
    if (!before) {
      throw new Error("missing seeded external-same-ms entry");
    }

    const database = openOpenClawAgentDatabase(scope);
    const external = new DatabaseSync(database.path);
    const maintenance = configureSqliteConnectionPragmas(external, {
      checkpointIntervalMs: 0,
      databaseLabel: "session-entry-external-same-ms-writer",
      databasePath: database.path,
      foreignKeys: true,
      synchronous: "NORMAL",
    });
    try {
      const updated = { ...before, label: "projection-probe-after" };
      external
        .prepare("UPDATE session_nodes SET entry_json = ?, label = ? WHERE session_key = ?")
        .run(JSON.stringify(updated), updated.label, scope.sessionKey);

      parseSessionEntryCalls.mockClear();
      const after = listSessionEntriesCore({ ...scope, clone: false, projection: "list" });

      expect(after[0]?.entry.label).toBe("projection-probe-after");
      expect(parseSessionEntryCalls).toHaveBeenCalledTimes(2);
    } finally {
      maintenance.close();
      external.close();
    }
  });

  it("observes a commit during a listing on the next read", async () => {
    const scope = createSessionScope("external-race");
    const siblingScope = { ...scope, sessionKey: "agent:main:external-race-sibling" };
    await upsertSessionEntryCore(scope, {
      label: "local-before",
      sessionId: "external-race-local",
      updatedAt: 1,
    });
    await upsertSessionEntryCore(siblingScope, {
      label: "external-before",
      sessionId: "external-race-sibling",
      updatedAt: 1,
    });
    listSessionEntriesCore(scope);

    const database = openOpenClawAgentDatabase(scope);
    const localEntry = {
      label: "local-after",
      sessionId: "external-race-local",
      updatedAt: 2,
    };
    database.db
      .prepare("UPDATE session_nodes SET entry_json = ?, updated_at = ? WHERE session_key = ?")
      .run(JSON.stringify(localEntry), localEntry.updatedAt, scope.sessionKey);

    const external = new DatabaseSync(database.path);
    const maintenance = configureSqliteConnectionPragmas(external, {
      checkpointIntervalMs: 0,
      databaseLabel: "session-entry-external-race-writer",
      databasePath: database.path,
      foreignKeys: true,
      synchronous: "NORMAL",
    });
    try {
      const externalEntry = {
        label: "external-after",
        sessionId: "external-race-sibling",
        updatedAt: 2,
      };
      parseSessionEntryCalls.mockImplementationOnce(() => {
        external
          .prepare("UPDATE session_nodes SET entry_json = ?, updated_at = ? WHERE session_key = ?")
          .run(JSON.stringify(externalEntry), externalEntry.updatedAt, siblingScope.sessionKey);
      });

      const entries = listSessionEntriesCore(scope);
      const byId = new Map(entries.map((row) => [row.entry.sessionId, row.entry]));

      expect(byId.get("external-race-local")?.label).toBe("local-after");
      expect(byId.get("external-race-sibling")?.label).toBe("external-before");
      expect(
        listSessionEntriesCore(scope).find(
          ({ entry }) => entry.sessionId === "external-race-sibling",
        )?.entry.label,
      ).toBe("external-after");
    } finally {
      maintenance.close();
      external.close();
    }
  });

  it("reloads added and removed keys after an untracked connection write", async () => {
    const scope = createSessionScope("same-connection-keys");
    const removedScope = { ...scope, sessionKey: "agent:main:same-connection-removed" };
    await upsertSessionEntryCore(scope, {
      label: "projection-probe-kept",
      sessionId: "same-connection-kept",
      updatedAt: 1,
    });
    await upsertSessionEntryCore(removedScope, {
      label: "projection-probe-removed",
      sessionId: "same-connection-removed",
      updatedAt: 1,
    });
    const before = listSessionEntriesCore({ ...scope, clone: false, projection: "list" });
    const keptProjection = before.find((row) => row.sessionKey === scope.sessionKey)?.entry;

    const database = openOpenClawAgentDatabase(scope);
    const insertedKey = "agent:main:same-connection-inserted";
    const insertedEntry = {
      label: "projection-probe-inserted",
      sessionId: "same-connection-inserted",
      updatedAt: 2,
    };
    database.db
      .prepare(
        "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at) VALUES (?, ?, ?, ?)",
      )
      .run(
        insertedKey,
        insertedEntry.sessionId,
        JSON.stringify(insertedEntry),
        insertedEntry.updatedAt,
      );
    database.db
      .prepare("DELETE FROM session_nodes WHERE session_key = ?")
      .run(removedScope.sessionKey);

    parseSessionEntryCalls.mockClear();
    const entries = listSessionEntriesCore({ ...scope, clone: false, projection: "list" });

    expect(entries.map((row) => row.sessionKey)).toEqual(
      [scope.sessionKey, insertedKey].toSorted(),
    );
    expect(entries.find((row) => row.sessionKey === scope.sessionKey)?.entry).toEqual(
      keptProjection,
    );
    expect(entries.find((row) => row.sessionKey === insertedKey)?.entry).toMatchObject(
      insertedEntry,
    );
    expect(parseSessionEntryCalls).toHaveBeenCalledTimes(2);
  });

  it("scales native tracked projection work with changed keys without parsing saved prompts", async () => {
    const scope = createSessionScope("changed-key-scaling");
    const rowCount = 24;
    for (let index = 0; index < rowCount; index++) {
      await upsertSessionEntryCore(
        { ...scope, sessionKey: `agent:main:changed-key-scaling-${index}` },
        {
          label: `projection-probe-${index}`,
          sessionId: `changed-key-scaling-${index}`,
          updatedAt: index + 1,
        },
      );
    }
    listSessionEntriesCore({ ...scope, clone: false, projection: "list" });

    parseSessionEntryCalls.mockClear();
    for (const index of [3, 19]) {
      const sessionKey = `agent:main:changed-key-scaling-${index}`;
      const entry = {
        label: `projection-probe-changed-${index}`,
        sessionId: `changed-key-scaling-${index}`,
        updatedAt: 1_000 + index,
        skillsSnapshot: { prompt: "large skill prompt".repeat(8192), skills: [] },
      };
      runOpenClawAgentWriteTransaction((database) => {
        writeSessionEntry(database, sessionKey, entry);
      }, scope);
    }

    const entries = listSessionEntriesCore({ ...scope, clone: false, projection: "list" });

    expect(entries).toHaveLength(rowCount);
    expect(parseSessionEntryCalls).toHaveBeenCalledTimes(2);
    expect(
      parseSessionEntryCalls.mock.calls.every(([json]) => Buffer.byteLength(json) < 1024),
    ).toBe(true);
  });

  it("patches only the tracked row after a native write", async () => {
    const scope = createSessionScope("write-through");
    const siblingScope = { ...scope, sessionKey: "agent:main:write-through-sibling" };
    await upsertSessionEntryCore(scope, {
      label: "projection-probe-before",
      sessionId: "write-through",
      updatedAt: 1,
    });
    await upsertSessionEntryCore(siblingScope, {
      label: "projection-probe-sibling",
      sessionId: "write-through-sibling",
      updatedAt: 1,
    });
    const before = listSessionEntriesCore({ ...scope, clone: false, projection: "list" });
    const siblingBefore = before.find((row) => row.sessionKey === siblingScope.sessionKey)?.entry;
    const database = openOpenClawAgentDatabase(scope);
    const cachedBefore = readSessionEntryCache(database, { cache: true });
    const changedEntryBefore = cachedBefore.entries.get(scope.sessionKey);
    const siblingEntryBefore = cachedBefore.entries.get(siblingScope.sessionKey);

    parseSessionEntryCalls.mockClear();
    runOpenClawAgentWriteTransaction((current) => {
      writeSessionEntry(current, scope.sessionKey, {
        sessionId: "write-through",
        label: "projection-probe-after",
        updatedAt: 2,
        skillsSnapshot: { prompt: "updated skill prompt", skills: [] },
      });
    }, scope);
    parseSessionEntryCalls.mockClear();
    const after = listSessionEntriesCore({ ...scope, clone: false, projection: "list" });

    expect(after.find((row) => row.sessionKey === scope.sessionKey)?.entry.label).toBe(
      "projection-probe-after",
    );
    expect(after.find((row) => row.sessionKey === siblingScope.sessionKey)?.entry).toBe(
      siblingBefore,
    );
    expect(parseSessionEntryCalls).not.toHaveBeenCalled();

    const cachedAfter = readSessionEntryCache(database, { cache: true });
    expect(cachedAfter.entries).toBe(cachedBefore.entries);
    expect(cachedAfter.keys).toBe(cachedBefore.keys);
    expect(cachedAfter.entries.get(scope.sessionKey)).not.toBe(changedEntryBefore);
    expect(cachedAfter.entries.get(siblingScope.sessionKey)).toBe(siblingEntryBefore);
    expect(cachedAfter.entries.get(siblingScope.sessionKey)).toBe(siblingBefore);
    expect(cachedAfter.entries.get(scope.sessionKey)?.skillsSnapshot).toBeUndefined();
    expect(loadSessionEntry(scope)?.skillsSnapshot?.prompt).toBe("updated skill prompt");
  });

  it("adds a native write to a warm snapshot without reparsing siblings", async () => {
    const scope = createSessionScope("write-through-insert");
    await upsertSessionEntryCore(scope, {
      label: "projection-probe-existing",
      sessionId: "write-through-existing",
      updatedAt: 1,
    });
    const existing = listSessionEntriesCore({ ...scope, clone: false, projection: "list" })[0]
      ?.entry;
    const database = openOpenClawAgentDatabase(scope);
    const cachedBefore = readSessionEntryCache(database, { cache: true });
    const existingEntry = cachedBefore.entries.get(scope.sessionKey);
    const insertedScope = { ...scope, sessionKey: "agent:main:write-through-inserted" };

    parseSessionEntryCalls.mockClear();
    runOpenClawAgentWriteTransaction((current) => {
      writeSessionEntry(current, insertedScope.sessionKey, {
        label: "projection-probe-inserted",
        sessionId: "write-through-inserted",
        updatedAt: 2,
      });
    }, scope);
    parseSessionEntryCalls.mockClear();
    const after = listSessionEntriesCore({ ...scope, clone: false, projection: "list" });

    expect(after.map((row) => row.sessionKey)).toEqual(
      [scope.sessionKey, insertedScope.sessionKey].toSorted(),
    );
    expect(after.find((row) => row.sessionKey === scope.sessionKey)?.entry).toBe(existing);
    expect(parseSessionEntryCalls).not.toHaveBeenCalled();

    const cachedAfter = readSessionEntryCache(database, { cache: true });
    expect(cachedAfter.entries).toBe(cachedBefore.entries);
    expect(cachedAfter.keys).toEqual([scope.sessionKey, insertedScope.sessionKey].toSorted());
    expect(cachedAfter.entries.get(scope.sessionKey)).toBe(existingEntry);
    expect(cachedAfter.entries.get(scope.sessionKey)).toBe(existing);
  });

  it("does not mask a same-timestamp raw write before a tracked write", async () => {
    const scope = createSessionScope("raw-before-tracked");
    const trackedScope = { ...scope, sessionKey: "agent:main:tracked-after-raw" };
    await upsertSessionEntryCore(scope, { label: "raw-before", sessionId: "raw", updatedAt: 1 });
    await upsertSessionEntryCore(trackedScope, {
      label: "tracked-before",
      sessionId: "tracked",
      updatedAt: 1,
    });
    listSessionEntriesCore(scope);

    const database = openOpenClawAgentDatabase(scope);
    const previous = loadSessionEntry(scope)!;
    const rawEntry = {
      ...previous,
      label: "raw-after",
    };
    database.db
      .prepare("UPDATE session_nodes SET entry_json = ?, updated_at = ? WHERE session_key = ?")
      .run(JSON.stringify(rawEntry), rawEntry.updatedAt, scope.sessionKey);
    await upsertSessionEntryCore(trackedScope, { label: "tracked-after", updatedAt: 2 });

    parseSessionEntryCalls.mockClear();
    const entries = listSessionEntriesCore(scope);
    const entriesBySessionId = new Map(entries.map((row) => [row.entry.sessionId, row.entry]));

    expect(entriesBySessionId.get("raw")).toMatchObject(rawEntry);
    expect(entriesBySessionId.get("tracked")).toMatchObject({
      label: "tracked-after",
      sessionId: "tracked",
    });
    expect(parseSessionEntryCalls).toHaveBeenCalledTimes(2);
  });

  it("invalidates cached keys when transcript creation inserts a placeholder node", async () => {
    const scope = createSessionScope("placeholder-key");
    await upsertSessionEntryCore(scope, { sessionId: "entry", updatedAt: 1 });
    const database = openOpenClawAgentDatabase(scope);
    const before = readSessionEntryCache(database, { cache: true });
    expect(before.keys).toEqual([scope.sessionKey]);

    const placeholderKey = "agent:main:placeholder-only";
    runOpenClawAgentWriteTransaction((transactionDatabase) => {
      ensureTranscriptSessionRoot(
        transactionDatabase,
        {
          agentId: scope.agentId,
          env: scope.env,
          sessionId: "placeholder-only",
          sessionKey: placeholderKey,
        },
        2,
      );
    }, scope);

    const after = readSessionEntryCache(database, { cache: true });
    expect(after.keys).toEqual([scope.sessionKey, placeholderKey]);
    expect(after.entries.get(scope.sessionKey)).not.toBe(before.entries.get(scope.sessionKey));
  });

  it("rejects a transcript write after its persisted owner changes", async () => {
    const scope = createSessionScope("transcript-owner-conflict");
    const sessionId = "owned-transcript-session";
    await upsertSessionEntryCore(scope, { sessionId, updatedAt: 1 });

    expect(() =>
      runOpenClawAgentWriteTransaction((database) => {
        ensureTranscriptSessionRoot(
          database,
          {
            agentId: scope.agentId,
            env: scope.env,
            sessionId,
            sessionKey: "agent:main:stale-owner",
          },
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
    const scope = createSessionScope("transaction-rollback");
    await upsertSessionEntryCore(scope, { label: "before", sessionId: "rollback", updatedAt: 1 });
    const borrowedBefore = listSessionEntriesCore({ ...scope, clone: false })[0]?.entry;
    expect(borrowedBefore?.label).toBe("before");
    if (!borrowedBefore) {
      throw new Error("missing seeded rollback entry");
    }

    expect(() =>
      runOpenClawAgentWriteTransaction((database) => {
        const updated = { ...borrowedBefore, label: "uncommitted", updatedAt: 2 };
        database.db
          .prepare("UPDATE session_nodes SET entry_json = ?, updated_at = ? WHERE session_key = ?")
          .run(JSON.stringify(updated), updated.updatedAt, scope.sessionKey);
        expect(loadSessionEntry({ ...scope, clone: false })?.label).toBe("uncommitted");
        throw new Error("roll back cache probe");
      }, scope),
    ).toThrow("roll back cache probe");

    parseSessionEntryCalls.mockClear();
    const borrowedAfter = listSessionEntriesCore({ ...scope, clone: false })[0]?.entry;
    expect(borrowedAfter).toStrictEqual(borrowedBefore);
    expect(borrowedAfter?.label).toBe("before");
    expect(parseSessionEntryCalls).not.toHaveBeenCalled();
  });

  it("isolates cloned results while borrowed views retain stable references", async () => {
    const scope = createSessionScope("clone-borrow");
    await upsertSessionEntryCore(scope, { label: "original", sessionId: "clone", updatedAt: 1 });

    const cloned = listSessionEntriesCore(scope)[0]?.entry;
    expect(cloned).toBeDefined();
    if (cloned) {
      cloned.label = "mutated";
    }
    expect(loadSessionEntry(scope)?.label).toBe("original");

    const view = openSessionEntryReadView(scope);
    const first = view.get(scope.sessionKey);
    expect(view.get(scope.sessionKey)).toStrictEqual(first);
    expect(view.entries()[0]?.entry).toStrictEqual(first);
  });

  it("honors latest reads after an untracked own-connection write", async () => {
    const scope = createSessionScope("latest");
    await upsertSessionEntryCore(scope, { label: "cached", sessionId: "latest", updatedAt: 1 });
    expect(listSessionEntriesCore(scope)[0]?.entry.label).toBe("cached");

    const database = openOpenClawAgentDatabase(scope);
    const updated = { label: "latest", sessionId: "latest", updatedAt: 2 };
    database.db
      .prepare("UPDATE session_nodes SET entry_json = ?, updated_at = ? WHERE session_key = ?")
      .run(JSON.stringify(updated), updated.updatedAt, scope.sessionKey);

    expect(listSessionEntriesCore(scope)[0]?.entry.label).toBe("latest");
    expect(loadSessionEntry({ ...scope, readConsistency: "latest" })?.label).toBe("latest");
  });
});
