import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listUsageCountedTranscriptStats } from "../../infra/session-cost-usage-collection.test-support.js";
import { openOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly-open.js";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../runtime-snapshot.js";
import {
  appendTranscriptMessageSync,
  assignSessionOwner,
  cleanupPluginHostSessionStore,
  listSessionEntriesCore,
  listSessionTranscriptInstances,
  loadSessionEntry,
  openSessionEntryReadView,
  replaceSessionEntrySync,
  upsertSessionEntryCore,
} from "./session-accessor.js";
import { readSessionEntryCache } from "./session-accessor.sqlite-entry-cache.js";
import { readReferencedSessionIds } from "./session-accessor.sqlite-lifecycle-state.js";
import { recordSessionParticipant } from "./session-accessor.sqlite-participants.native.js";
import { ensureTranscriptSessionRoot } from "./session-accessor.sqlite-transcript-state.js";
import { appendTranscriptEventSync } from "./session-accessor.sqlite-transcript-write.test-support.js";
import type { SessionEntry } from "./types.js";

const parseSessionEntryCalls = vi.hoisted(() => vi.fn());
vi.mock("./session-accessor.sqlite-status.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session-accessor.sqlite-status.js")>();
  return {
    ...actual,
    parseSessionEntryJson: (...args: Parameters<typeof actual.parseSessionEntryJson>) => {
      // Observe list payload decoding independently of the selected SQL columns.
      if (args[1] === "list") {
        parseSessionEntryCalls(args[0].entry_json);
      }
      return actual.parseSessionEntryJson(...args);
    },
  };
});

afterAll(clearRuntimeConfigSnapshot);
const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-entry-cache-");

beforeEach(() => {
  parseSessionEntryCalls.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

function createSessionScope(label: string) {
  const stateDir = sessionDirs.make();
  setRuntimeConfigSnapshot({});
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

describe("pre-device-folder session entries", () => {
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
    insertRaw(database.db, scope.sessionKey, previousEntry);
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
    expect(listed?.deviceFolder).toBeUndefined();
    expect(listed?.skillsSnapshot).toBeUndefined();
    expect(parseSessionEntryCalls).toHaveBeenCalled();
    parseSessionEntryCalls.mockClear();
    expect(listingEntries(scope).get(scope.sessionKey)).toBe(listed);
    expect(parseSessionEntryCalls).not.toHaveBeenCalled();
    expect(openSessionEntryReadView(scope).get(scope.sessionKey)).toEqual(listed);

    await upsertSessionEntryCore(scope, { ...full!, label: "Continued after upgrade" });
    await closeOpenClawAgentDatabasesAsync(scope.env.OPENCLAW_STATE_DIR);
    const continued = loadSessionEntry(scope);
    expect(continued).toMatchObject({
      sessionId: previousEntry.sessionId,
      label: "Continued after upgrade",
      modelOverride: previousEntry.modelOverride,
      worktree: previousEntry.worktree,
    });
    expect(continued!.updatedAt).toBeGreaterThanOrEqual(previousEntry.updatedAt);
    expect(continued?.deviceFolder).toBeUndefined();
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
    "cleans selected plugin metadata without materializing siblings or saved prompts (%s)",
    async (mode) => {
      const scope = createSessionScope("plugin-cleanup");
      vi.stubEnv("OPENCLAW_STATE_DIR", scope.env.OPENCLAW_STATE_DIR);
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
      const clone = vi.spyOn(globalThis, "structuredClone");
      try {
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
        expect(
          clone.mock.calls.some(
            ([value]) => isRecord(value) && value.sessionId === "plugin-cleanup-sibling",
          ),
        ).toBe(false);
      } finally {
        clone.mockRestore();
      }
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
      deviceFolder: { deviceId: "device-one", path: "/home/example/project" },
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
      expect(first?.deviceFolder).toEqual(fullEntry.deviceFolder);
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
      copiedListEntry!.deviceFolder!.path = "/mutated-copy";
      expect(first?.deviceFolder?.path).toBe("/home/example/project");
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

  it("publishes a native replacement without losing sibling metadata", async () => {
    const { scope, sibling } = await seedPair("write-through");
    openOpenClawAgentDatabase(scope);
    const before = loadSessionEntry(scope)!;
    const siblingBefore = listingEntries(scope).get(sibling.sessionKey);

    parseSessionEntryCalls.mockClear();
    replaceSessionEntrySync(scope, {
      ...before,
      label: "after",
      updatedAt: 2,
      skillsSnapshot: { prompt: "updated skill prompt", skills: [] },
    });
    parseSessionEntryCalls.mockClear();
    const after = listingEntries(scope);
    expect(after.get(scope.sessionKey)?.label).toBe("after");
    expect(after.get(sibling.sessionKey)).toStrictEqual(siblingBefore);
    expect(
      parseSessionEntryCalls.mock.calls.every(([json]) => Buffer.byteLength(json) < 1024),
    ).toBe(true);
    expect(after.get(scope.sessionKey)?.skillsSnapshot).toBeUndefined();
    expect(loadSessionEntry(scope)?.skillsSnapshot?.prompt).toBe("updated skill prompt");
  });

  it("adds a native insertion to a warm snapshot without reparsing siblings", async () => {
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
    expect(loadSessionEntry(scope)?.label).toBe("before");
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
    expect(parseSessionEntryCalls).toHaveBeenCalledTimes(1);
    parseSessionEntryCalls.mockClear();
    expect(listSessionEntriesCore({ ...scope, clone: false })[0]?.entry).toBe(borrowedAfter);
    expect(parseSessionEntryCalls).not.toHaveBeenCalled();
  });
});
