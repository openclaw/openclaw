import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listUsageCountedTranscriptStats } from "../../infra/session-cost-usage-collection.js";
import { configureSqliteConnectionPragmas } from "../../infra/sqlite-wal.js";
import { openOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly-open.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
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
import { readSessionEntryCache } from "./session-accessor.sqlite-entry-cache.js";
import { captureSessionEntryRead } from "./session-accessor.sqlite-entry-read-lifetime.js";
import { readReferencedSessionIds } from "./session-accessor.sqlite-lifecycle-state.js";
import { recordSessionParticipant } from "./session-accessor.sqlite-participants.native.js";
import { ensureTranscriptSessionRoot } from "./session-accessor.sqlite-transcript-state.js";
import type { SessionEntry } from "./types.js";

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

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-entry-cache-");

beforeEach(() => {
  parseSessionEntryCalls.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

function createSessionScope(label: string) {
  const stateDir = sessionDirs.make();
  return {
    agentId: "main",
    env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    sessionKey: `agent:main:${label}`,
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

async function seedPair(label: string) {
  const scope = await seed(label, sessionEntry("first", "before"));
  const sibling = { ...scope, sessionKey: `${scope.sessionKey}-sibling` };
  await upsertSessionEntryCore(sibling, sessionEntry("second", "sibling"));
  return { scope, sibling };
}

function writeRaw(db: DatabaseSync, sessionKey: string, value: SessionEntry) {
  db.prepare("UPDATE session_nodes SET entry_json = ?, updated_at = ? WHERE session_key = ?").run(
    JSON.stringify(value),
    value.updatedAt,
    sessionKey,
  );
}

function insertRaw(db: DatabaseSync, sessionKey: string, value: SessionEntry) {
  db.prepare(
    "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at) VALUES (?, ?, ?, ?)",
  ).run(sessionKey, value.sessionId, JSON.stringify(value), value.updatedAt);
}

function listingEntries(scope: SessionScope, clone = false) {
  return new Map(
    listSessionEntriesCore({ ...scope, clone }).map(({ sessionKey, entry }) => [sessionKey, entry]),
  );
}

function savedPrompts(prompt: string) {
  return {
    skillsSnapshot: { prompt, skills: [] },
    systemPromptReport: {
      source: "run" as const,
      generatedAt: 1,
      systemPrompt: { chars: 1, projectContextChars: 0, nonProjectContextChars: 1 },
      injectedWorkspaceFiles: [],
      skills: { promptChars: 0, entries: [] },
      tools: { listChars: 0, schemaChars: 0, entries: [] },
    },
  };
}

describe("exact session entry read lifetimes", () => {
  it("keeps a selected read through sibling writes and full-list expansion", async () => {
    const { scope, sibling } = await seedPair("selected-read");
    const database = openOpenClawAgentDatabase(scope);
    parseSessionEntryCalls.mockClear();
    const read = captureSessionEntryRead(database, scope.sessionKey);
    try {
      expect(read.entry).toMatchObject({ sessionId: "first", label: "before" });
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

  it("keeps identical canonical facts current after an external delete/recreate", async () => {
    const scope = await seed("selected-read-aba");
    const database = openOpenClawAgentDatabase(scope);
    const read = captureSessionEntryRead(database, scope.sessionKey);
    const connection = new DatabaseSync(database.path);
    try {
      connection.exec("CREATE TEMP TABLE saved_node AS SELECT * FROM session_nodes;");
      connection.prepare("DELETE FROM session_nodes WHERE session_key = ?").run(scope.sessionKey);
      connection.exec("INSERT INTO session_nodes SELECT * FROM saved_node;");
      // Metadata depends on current canonical facts, not whether identical rows were rewritten.
      expect(read.isCurrent()).toBe(true);
      expect(loadSessionEntry(scope)).toMatchObject(read.entry!);
    } finally {
      read.release();
      connection.close();
    }
  });

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
    insertRaw(database.db, scope.sessionKey, { sessionId: "current", updatedAt: 1 });
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
    "scans plugin cleanup metadata without decoding saved prompts (%s)",
    async (mode) => {
      const scope = createSessionScope("plugin-cleanup");
      const siblingScope = { ...scope, sessionKey: "agent:main:plugin-cleanup-sibling" };
      const { skillsSnapshot, systemPromptReport } = savedPrompts(
        "unneeded cleanup prompt".repeat(4096),
      );
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

  it("retains only listing metadata while full reads preserve saved prompt state", async () => {
    const prompt = "large skill prompt".repeat(8192);
    const scope = await seed("lazy-list-projection", {
      label: "projected",
      worktree: { id: "worktree-1", branch: "main", repoRoot: "/repo" },
      ...savedPrompts(prompt),
    });

    const cloneSpy = vi.spyOn(globalThis, "structuredClone");
    try {
      const fullEntry = listSessionEntriesCore({ agentId: scope.agentId, env: scope.env })[0]!
        .entry;
      parseSessionEntryCalls.mockClear();
      const first = listingEntries(scope).get(scope.sessionKey);
      const second = listingEntries(scope).get(scope.sessionKey);

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

      fullEntry.worktree!.branch = "mutated full read";
      fullEntry.skillsSnapshot!.prompt = "mutated full prompt";
      const fullAgain = listSessionEntriesCore({ ...scope, projection: "full" })[0]?.entry;
      expect(fullAgain?.worktree?.branch).toBe("main");
      expect(fullAgain?.skillsSnapshot?.prompt).toBe(prompt);
      expect(fullAgain?.systemPromptReport?.source).toBe("run");
      expect(cloneSpy).not.toHaveBeenCalled();

      const copiedListEntry = listSessionEntriesCore(scope)[0]?.entry;
      expect(copiedListEntry?.worktree?.branch).toBe("main");
      expect(copiedListEntry?.worktree).not.toBe(first?.worktree);
      const view = openSessionEntryReadView(scope);
      expect(view.get(scope.sessionKey)).toStrictEqual(copiedListEntry);
      expect(view.entries()[0]?.entry).toStrictEqual(copiedListEntry);
      copiedListEntry!.worktree!.branch = "mutated list copy";
      expect(first?.worktree?.branch).toBe("main");
      expect(listingEntries(scope).get(scope.sessionKey)).toBe(first);
    } finally {
      cloneSpy.mockRestore();
    }
  });

  it("keeps same-path caches isolated by live connection", async () => {
    const scope = await seed("connection-identity");
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
      const alternateDatabase = { agentId: primary.agentId, db: alternate };
      const alternateEntry = readSessionEntryCache(alternateDatabase, { cache: true }).entries.get(
        scope.sessionKey,
      );
      expect(alternateEntry?.label).toBe("connection-identity");
      expect(
        parse.mock.calls.filter(([json]) => json.includes('"sessionId":"connection-identity"')),
      ).toHaveLength(1);

      parseSessionEntryCalls.mockClear();
      const second = listSessionEntriesCore({ ...scope, clone: false });

      expect(second[0]?.entry).toBe(first[0]?.entry);
      expect(parseSessionEntryCalls).not.toHaveBeenCalled();

      parseSessionEntryCalls.mockClear();
      const alternateAgain = readSessionEntryCache(alternateDatabase, { cache: true });

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
    const { scope, sibling } = await seedPair("transcript-write");
    const first = listingEntries(scope);

    await appendTranscriptMessage(
      { ...scope, sessionId: "first" },
      { message: { role: "user", content: [{ type: "text", text: "cache probe" }] }, now: 2 },
    );
    parseSessionEntryCalls.mockClear();

    const second = listingEntries(scope);

    expect(second.get(scope.sessionKey)).toBe(first.get(scope.sessionKey));
    expect(second.get(sibling.sessionKey)).toBe(first.get(sibling.sessionKey));
    expect(parseSessionEntryCalls).not.toHaveBeenCalled();
  });

  it("observes a same-timestamp commit during a listing on the next read", async () => {
    const { scope, sibling } = await seedPair("external-race");
    listSessionEntriesCore(scope);

    const database = openOpenClawAgentDatabase(scope);
    const localEntry = sessionEntry("first", "local-after", 2);
    writeRaw(database.db, scope.sessionKey, localEntry);

    const external = new DatabaseSync(database.path);
    const maintenance = configureSqliteConnectionPragmas(external, {
      checkpointIntervalMs: 0,
      databaseLabel: "session-entry-external-race-writer",
      databasePath: database.path,
      foreignKeys: true,
      synchronous: "NORMAL",
    });
    try {
      const externalEntry = sessionEntry("second", "external-after");
      parseSessionEntryCalls.mockImplementationOnce(() => {
        writeRaw(external, sibling.sessionKey, externalEntry);
      });

      const entries = listingEntries(scope, true);
      expect(entries.get(scope.sessionKey)?.label).toBe("local-after");
      expect(entries.get(sibling.sessionKey)?.label).toBe("sibling");
      expect(listingEntries(scope, true).get(sibling.sessionKey)?.label).toBe("external-after");
    } finally {
      maintenance.close();
      external.close();
    }
  });

  it("reloads added and removed keys after an untracked connection write", async () => {
    const { scope, sibling } = await seedPair("raw-keys");
    const keptProjection = listingEntries(scope).get(scope.sessionKey);
    const database = openOpenClawAgentDatabase(scope);
    const insertedKey = "agent:main:inserted";
    const insertedEntry = sessionEntry("inserted", "new", 2);
    insertRaw(database.db, insertedKey, insertedEntry);
    database.db.prepare("DELETE FROM session_nodes WHERE session_key = ?").run(sibling.sessionKey);

    parseSessionEntryCalls.mockClear();
    const entries = listingEntries(scope);
    expect([...entries.keys()]).toEqual([scope.sessionKey, insertedKey].toSorted());
    expect(entries.get(scope.sessionKey)).toEqual(keptProjection);
    expect(entries.get(insertedKey)).toMatchObject(insertedEntry);
    expect(parseSessionEntryCalls).toHaveBeenCalledTimes(2);
  });

  it("patches only the tracked row after a same-process upsert", async () => {
    const { scope, sibling } = await seedPair("write-through");
    const siblingBefore = listingEntries(scope).get(sibling.sessionKey);

    parseSessionEntryCalls.mockClear();
    await upsertSessionEntryCore(scope, {
      label: "after",
      updatedAt: 2,
      skillsSnapshot: { prompt: "updated skill prompt", skills: [] },
    });
    parseSessionEntryCalls.mockClear();
    const after = listingEntries(scope);
    expect(after.get(scope.sessionKey)?.label).toBe("after");
    expect(after.get(sibling.sessionKey)).toBe(siblingBefore);
    expect(parseSessionEntryCalls).not.toHaveBeenCalled();
    expect(after.get(scope.sessionKey)?.skillsSnapshot).toBeUndefined();
    expect(loadSessionEntry(scope)?.skillsSnapshot?.prompt).toBe("updated skill prompt");
  });

  it("adds a tracked upsert to a warm snapshot without reparsing siblings", async () => {
    const scope = await seed("write-through-insert");
    const existing = listingEntries(scope).get(scope.sessionKey);
    const inserted = { ...scope, sessionKey: "agent:main:inserted" };
    await upsertSessionEntryCore(inserted, sessionEntry("inserted", "new", 2));
    parseSessionEntryCalls.mockClear();
    const after = listingEntries(scope);
    expect([...after.keys()]).toEqual([scope.sessionKey, inserted.sessionKey].toSorted());
    expect(after.get(scope.sessionKey)).toBe(existing);
    expect(parseSessionEntryCalls).not.toHaveBeenCalled();
  });

  it("does not mask a same-timestamp raw write before a tracked write", async () => {
    const { scope, sibling } = await seedPair("raw-before-tracked");
    listSessionEntriesCore(scope);

    const database = openOpenClawAgentDatabase(scope);
    const rawEntry = { ...loadSessionEntry(scope)!, label: "raw-after" };
    writeRaw(database.db, scope.sessionKey, rawEntry);
    await upsertSessionEntryCore(sibling, { label: "tracked-after", updatedAt: 2 });

    parseSessionEntryCalls.mockClear();
    const entries = listingEntries(scope, true);
    expect(entries.get(scope.sessionKey)).toMatchObject(rawEntry);
    expect(entries.get(sibling.sessionKey)).toMatchObject({
      label: "tracked-after",
      sessionId: "second",
    });
    expect(parseSessionEntryCalls).toHaveBeenCalledTimes(2);
    expect(loadSessionEntry({ ...scope, readConsistency: "latest" })).toMatchObject(rawEntry);
  });

  it("invalidates cached keys when transcript creation inserts a placeholder node", async () => {
    const scope = await seed("placeholder-key", { sessionId: "entry", updatedAt: 1 });
    const database = openOpenClawAgentDatabase(scope);
    const before = readSessionEntryCache(database, { cache: true });
    expect(before.keys).toEqual([scope.sessionKey]);

    const placeholderKey = "agent:main:placeholder-only";
    runOpenClawAgentWriteTransaction((transactionDatabase) => {
      ensureTranscriptSessionRoot(
        transactionDatabase,
        {
          ...scope,
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
            ...scope,
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
    const scope = await seed("transaction-rollback", sessionEntry("rollback", "before"));
    const borrowedBefore = listSessionEntriesCore({ ...scope, clone: false })[0]!.entry;
    expect(borrowedBefore.label).toBe("before");

    expect(() =>
      runOpenClawAgentWriteTransaction((database) => {
        const updated = { ...borrowedBefore, label: "uncommitted", updatedAt: 2 };
        writeRaw(database.db, scope.sessionKey, updated);
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
});
