import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterAll, describe, expect, it, vi } from "vitest";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import type { SqlConnection } from "../../infra/sql-connection.js";
import { invalidateOpenClawAgentCanonicalValidation } from "../../state/openclaw-agent-db-validation-cache.js";
import {
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import {
  assignSessionOwner,
  listSessionEntriesReadOnly,
  loadSessionEntryReadOnly,
  replaceSessionEntrySync,
  upsertSessionEntryCore,
} from "./session-accessor.js";
import { scanDoctorSessionEntriesStrict } from "./session-accessor.sqlite-canonical-inventory.js";
import { readSessionEntryCache } from "./session-accessor.sqlite-entry-cache.js";
import { listSessionEntryRows } from "./session-accessor.sqlite-entry.js";
import { recordSessionParticipant } from "./session-accessor.sqlite-participants.native.js";
import { ensureTranscriptSessionRoot } from "./session-accessor.sqlite-transcript-state.js";
import { appendTranscriptEventInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import {
  markCanonicalSessionValidationPending,
  setCanonicalSqliteSessionMainKey,
} from "./session-canonical-key.js";
import type { SessionEntry } from "./types.js";

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-cold-session-keys-");

function createScope() {
  const stateDir = sessionDirs.make();
  return {
    agentId: "main",
    env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    storePath: path.join(stateDir, "agents/main/agent/openclaw-agent.sqlite"),
    sessionKey: "agent:main:cold-key",
  };
}

function open(scope: ReturnType<typeof createScope>) {
  return openOpenClawAgentDatabase({ ...scope, path: scope.storePath });
}

function list(scope: ReturnType<typeof createScope>, clone?: boolean) {
  return listSessionEntriesReadOnly({ ...scope, projection: "list", clone });
}

function updateRow(
  db: SqlConnection,
  key: string,
  assignments: string,
  ...values: SQLInputValue[]
) {
  db.prepare(`UPDATE session_nodes SET ${assignments} WHERE session_key = ?`).run(...values, key);
}

describe("cold canonical session validation", () => {
  it("keeps timestamp-mismatched keys without strengthening Doctor validation", () => {
    const scope = createScope();
    replaceSessionEntrySync(scope, { sessionId: "cold-key", updatedAt: 1 });
    const database = open(scope);
    updateRow(database.db, scope.sessionKey, "updated_at = 2");
    updateRow(database.db, scope.sessionKey, "entry_valid = 1");
    closeOpenClawAgentDatabasesForTest();
    const held = open(scope);
    expect(list(scope)).toEqual([]);
    const cached = readSessionEntryCache(held, { cache: true });
    expect(cached.keys).toEqual([scope.sessionKey]);
    expect(cached.entries.size).toBe(0);
    const doctor: SessionEntry[] = [];
    expect(scanDoctorSessionEntriesStrict(scope, ({ entry }) => doctor.push(entry))).toBe(1);
    expect(doctor[0]?.updatedAt).toBe(1);
  });

  it.each([false, true])(
    "reloads metadata after a commit during required validation (pending rewrite: %s)",
    (certifiedReopen) => {
      const scope = createScope();
      const entry = { sessionId: "cold-key", updatedAt: 1, label: "before" };
      replaceSessionEntrySync(scope, entry);
      const pending = open(scope);
      if (certifiedReopen) {
        pending.db.exec(
          "UPDATE session_nodes SET entry_json = entry_json || ' '; UPDATE session_nodes SET entry_valid = 1",
        );
        markCanonicalSessionValidationPending(pending, [scope.sessionKey]);
        closeOpenClawAgentDatabaseByPath(scope.storePath);
      } else {
        invalidateOpenClawAgentCanonicalValidation(pending);
        closeOpenClawAgentDatabasesForTest();
      }
      open(scope);
      const writer = openNodeSqliteDatabase(scope.storePath);
      const originalParse = JSON.parse;
      let committed = false;
      const parse = vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
        const value = originalParse(text, reviver);
        if (!committed && value?.sessionId === entry.sessionId && value?.label === "before") {
          committed = true;
          writer.exec("BEGIN IMMEDIATE");
          updateRow(
            writer,
            scope.sessionKey,
            "entry_json = ?, label = 'after'",
            JSON.stringify({ ...entry, label: "after" }),
          );
          updateRow(writer, scope.sessionKey, "entry_valid = 1");
          markCanonicalSessionValidationPending({ agentId: scope.agentId, db: writer }, [
            scope.sessionKey,
          ]);
          writer.exec("COMMIT");
        }
        return value;
      });
      try {
        expect(list(scope)[0]?.entry.label).toBe("after");
        expect(committed).toBe(true);
        expect(list(scope)[0]?.entry.label).toBe("after");
      } finally {
        parse.mockRestore();
        writer.close();
      }
    },
  );

  it("does not publish a partial snapshot after a later malformed row", () => {
    const scope = createScope();
    const otherKey = "agent:main:z-later";
    replaceSessionEntrySync(scope, { sessionId: "cold-key", updatedAt: 1, label: "before" });
    replaceSessionEntrySync(
      { ...scope, sessionKey: otherKey },
      { sessionId: "later", updatedAt: 1 },
    );
    const database = open(scope);
    markCanonicalSessionValidationPending(database, [otherKey]);
    updateRow(database.db, otherKey, "entry_json = '{'");
    closeOpenClawAgentDatabasesForTest();
    const held = open(scope);
    expect(() => list(scope)).toThrow("openclaw doctor --fix");
    expect(() => list(scope)).toThrow("openclaw doctor --fix");
    for (const [key, id] of [
      [scope.sessionKey, "cold-key"],
      [otherKey, "later"],
    ] as const) {
      updateRow(
        held.db,
        key,
        "entry_json = ?",
        JSON.stringify({ sessionId: id, updatedAt: 1, label: "repaired" }),
      );
      updateRow(held.db, key, "entry_valid = 1");
    }
    expect(list(scope).map(({ entry }) => entry.label)).toEqual(["repaired", "repaired"]);
  });

  it("preserves a literal main key after the main alias changes with a warm reader", () => {
    const scope = { ...createScope(), sessionKey: "agent:main:main" };
    const read = () => listSessionEntryRows(scope);
    replaceSessionEntrySync(scope, { sessionId: "main-alias", updatedAt: 1 });
    expect(read()).toHaveLength(1);
    const database = open(scope);
    setCanonicalSqliteSessionMainKey(database, "custom");
    expect(
      read().map(({ sessionKey, entry }) => ({ sessionKey, sessionId: entry.sessionId })),
    ).toEqual([{ sessionKey: "agent:main:main", sessionId: "main-alias" }]);
  });

  it("revalidates a changed policy before writing a literal main transcript root", () => {
    const scope = createScope();
    const otherKey = "agent:main:z-later";
    const otherEntry = { sessionId: "later", updatedAt: 1 };
    replaceSessionEntrySync(scope, { sessionId: "cold-key", updatedAt: 1 });
    replaceSessionEntrySync({ ...scope, sessionKey: otherKey }, otherEntry);
    const database = open(scope);
    runOpenClawAgentWriteTransaction(
      (writer) => {
        ensureTranscriptSessionRoot(writer, { ...scope, sessionId: "cold-key" }, 1);
      },
      { ...scope, path: scope.storePath },
    );
    const append = () =>
      runOpenClawAgentWriteTransaction(
        (writer) =>
          appendTranscriptEventInTransaction(
            writer,
            { ...scope, sessionKey: "agent:main:main", sessionId: "new-root" },
            { type: "message", id: "new-message", message: { role: "user", content: "new" } },
          ),
        { ...scope, path: scope.storePath },
      );
    // Config publication invalidates the previously admitted policy before another write.
    const external = new DatabaseSync(scope.storePath);
    try {
      setCanonicalSqliteSessionMainKey(database, "custom");
      external.exec("BEGIN IMMEDIATE");
      updateRow(external, otherKey, "entry_json = '{'");
      markCanonicalSessionValidationPending({ agentId: scope.agentId, db: external }, [otherKey]);
      external.exec("COMMIT");
      expect(append).toThrow(
        "invalid persisted session row requires repair for agent:main:z-later",
      );
      expect(
        database.db
          .prepare("SELECT session_id FROM session_windows WHERE session_id = ?")
          .get("new-root"),
      ).toBeUndefined();
      expect(
        database.db
          .prepare("SELECT seq FROM transcript_events WHERE session_id = ?")
          .all("new-root"),
      ).toEqual([]);
      updateRow(external, otherKey, "entry_json = ?", JSON.stringify(otherEntry));
      updateRow(external, otherKey, "entry_valid = 1");
      expect(append()).toEqual(expect.any(String));
      expect(
        database.db
          .prepare("SELECT session_key FROM session_windows WHERE session_id = ?")
          .get("new-root"),
      ).toEqual({ session_key: "agent:main:main" });
      expect(
        database.db
          .prepare("SELECT seq FROM transcript_events WHERE session_id = ?")
          .all("new-root"),
      ).toEqual([{ seq: 0 }]);
    } finally {
      external.close();
    }
  });

  it("decodes cold list metadata once and preserves projected values with a retained handle", () => {
    const scope = createScope();
    const sourceOwner = { actor: { type: "agent" as const, id: "json-owner" } };
    replaceSessionEntrySync(scope, {
      sessionId: "cold-key",
      updatedAt: 1,
      owner: sourceOwner,
      skillsSnapshot: { prompt: "saved prompt".repeat(4096), skills: [] },
    });
    assignSessionOwner(scope, {
      owner: { type: "agent", id: "column-owner" },
      assignedBy: { type: "agent", id: "assigner" },
      assignedAt: 2,
    });
    recordSessionParticipant(scope, {
      identity: { type: "profile", id: "participant" },
      promptedAt: 3,
    });
    const placeholderKey = "agent:main:retained";
    runOpenClawAgentWriteTransaction((database) => {
      ensureTranscriptSessionRoot(
        database,
        { ...scope, sessionKey: placeholderKey, sessionId: "retained" },
        4,
      );
    }, scope);
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    const database = open(scope);
    const parse = vi.spyOn(JSON, "parse");
    try {
      const rows = list(scope, false);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.entry).toMatchObject({
        sessionId: "cold-key",
        owner: {
          actor: { type: "agent", id: "column-owner" },
          assignedBy: { type: "agent", id: "assigner" },
          assignedAt: 2,
        },
        participants: [{ identity: { type: "profile", id: "participant" } }],
        participantCount: 1,
      });
      expect(rows[0]?.entry.skillsSnapshot).toBeUndefined();
      expect(
        parse.mock.calls.filter(([value]) => value.includes('"sessionId":"cold-key"')),
      ).toHaveLength(1);
      const cached = readSessionEntryCache(database, { cache: true });
      expect(cached.keys).toEqual([scope.sessionKey, placeholderKey]);
      expect(cached.entries.has(placeholderKey)).toBe(false);
      expect(cached.entries.get(scope.sessionKey)).toBe(rows[0]?.entry);
    } finally {
      parse.mockRestore();
    }
    const doctor: SessionEntry[] = [];
    expect(scanDoctorSessionEntriesStrict(scope, ({ entry }) => doctor.push(entry))).toBe(1);
    expect(doctor[0]?.owner).toBeUndefined();
    expect(doctor[0]?.skillsSnapshot?.prompt).toBe("saved prompt".repeat(4096));
  });

  it("omits saved prompts before decoding keys but retains them for Doctor", async () => {
    const scope = createScope();
    const prompt = "synthetic saved prompt ".repeat(8192);
    await upsertSessionEntryCore(scope, { sessionId: "cold-key", updatedAt: 1 });
    await upsertSessionEntryCore(
      { ...scope, sessionKey: "agent:main:unrelated" },
      { sessionId: "unrelated", updatedAt: 2, skillsSnapshot: { prompt, skills: [] } },
    );
    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();

    const parse = vi.spyOn(JSON, "parse");
    try {
      expect(loadSessionEntryReadOnly(scope)?.sessionId).toBe("cold-key");
      expect(parse.mock.calls.filter(([value]) => value.includes(prompt))).toHaveLength(0);
    } finally {
      parse.mockRestore();
    }

    const entries: SessionEntry[] = [];
    expect(scanDoctorSessionEntriesStrict(scope, ({ entry }) => entries.push(entry))).toBe(2);
    expect(entries.find((entry) => entry.sessionId === "unrelated")?.skillsSnapshot?.prompt).toBe(
      prompt,
    );
  });

  it("still rejects divergent lineage on the first read", async () => {
    const scope = createScope();
    await upsertSessionEntryCore(scope, {
      sessionId: "cold-key",
      updatedAt: 1,
      parentSessionKey: "agent:main:parent",
      skillsSnapshot: { prompt: "synthetic saved prompt", skills: [] },
    });
    const database = open(scope);
    markCanonicalSessionValidationPending(database, [scope.sessionKey]);
    updateRow(database.db, scope.sessionKey, "parent_session_key = ?", "agent:main:different");
    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();

    expect(() => loadSessionEntryReadOnly(scope)).toThrow("openclaw doctor --fix");
  });
});
