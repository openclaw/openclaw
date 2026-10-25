import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import { ensureTranscriptSessionRoot } from "./session-accessor.sqlite-transcript-state.js";
import { appendTranscriptEventInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import {
  projectPublicSessionEntry,
  projectExecutionSessionEntry,
} from "./session-entry-projection.js";
import type { SessionEntry } from "./types.js";

const retainedPrompt = "retained skill prompt ".repeat(400);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

function createFixture() {
  const scope = {
    agentId: "main",
    env: { ...process.env, OPENCLAW_STATE_DIR: tempDirs.make("session-provenance-") },
    sessionKey: "agent:main:provenance",
  };
  const database = openOpenClawAgentDatabase(scope);
  const entry: SessionEntry = {
    sessionId: "target",
    updatedAt: 20,
    skillsSnapshot: { prompt: retainedPrompt, skills: [] },
    pluginOwnerId: "plugin-owner",
    hookExternalContentSource: "webhook",
    acp: {
      backend: "acpx",
      agent: "test-agent",
      runtimeSessionName: "provenance-test",
      mode: "persistent",
      state: "idle",
      lastActivityAt: 10,
    },
  };
  const transcriptScope = { ...scope, sessionId: entry.sessionId };
  const read = (table: string, columns: string, key = "session_key", id = scope.sessionKey) =>
    database.db.prepare(`SELECT ${columns} FROM ${table} WHERE ${key} = ?`).get(id);
  const window = (columns: string) =>
    read("session_windows", columns, "session_id", entry.sessionId);
  const append = () =>
    appendTranscriptEventInTransaction(database, transcriptScope, {
      type: "session",
      id: entry.sessionId,
      timestamp: 10,
    });
  return { scope, database, entry, transcriptScope, read, window, append };
}

it.each([
  ["known provenance with hot rows", "known", "same", true, 1],
  ["unknown same session without hot rows", "unknown", "same", false, 0],
  ["unknown absent entry without hot rows", "unknown", "absent", false, 1],
  ["unknown different session without hot rows", "unknown", "different", false, 1],
  ["unknown different session with hot rows", "unknown", "different", true, 0],
] as const)("preserves %s", (_name, root, previous, hot, provenance) => {
  const { scope, database, entry, transcriptScope, read, window, append } = createFixture();
  if (previous !== "absent") {
    replaceSessionEntrySync(scope, {
      ...entry,
      sessionId: previous === "same" ? entry.sessionId : "previous",
      updatedAt: 10,
    });
  }
  runOpenClawAgentWriteTransaction((db) => {
    if (root === "unknown") {
      ensureTranscriptSessionRoot(db, transcriptScope, 10);
      // Migrated windows have no trusted entry provenance, even when an entry survives.
      db.db
        .prepare(
          "UPDATE session_windows SET session_entry_provenance = 0, acp_owned = 0, plugin_owner_id = NULL, hook_external_content_source = NULL WHERE session_id = ?",
        )
        .run(entry.sessionId);
    }
    if (hot) {
      append();
    }
  }, scope);

  let boundTextBytes = 0;
  const prepare = database.db.prepare.bind(database.db);
  using _ = vi.spyOn(database.db, "prepare").mockImplementation((sql) => {
    const statement = prepare(sql);
    statement.run = new Proxy(statement.run.bind(statement), {
      apply(run, receiver, args) {
        boundTextBytes += args.reduce(
          (bytes, value) => bytes + (typeof value === "string" ? Buffer.byteLength(value) : 0),
          0,
        );
        return Reflect.apply(run, receiver, args);
      },
    });
    return statement;
  });
  // Keep the serialized-byte budget, independently of the writer's query shape.
  replaceSessionEntrySync(
    scope,
    root === "known"
      ? { sessionId: entry.sessionId, updatedAt: 20, skillsSnapshot: entry.skillsSnapshot }
      : entry,
  );
  expect(boundTextBytes).toBeGreaterThan(0);
  expect(boundTextBytes).toBeLessThanOrEqual(Buffer.byteLength(retainedPrompt) * 1.5 + 4096);
  const stored = read("session_nodes", "entry_json, entry_valid");
  expect(stored?.entry_valid).toBe(1);
  expect(JSON.parse(String(stored?.entry_json))).toMatchObject({ sessionId: entry.sessionId });
  const savedSkills = database.db
    .prepare(
      "SELECT value_json FROM session_entry_snapshots WHERE session_key = ? AND field = 'skillsSnapshot'",
    )
    .get(scope.sessionKey);
  expect(JSON.parse(String(savedSkills?.value_json))).toEqual(entry.skillsSnapshot);
  expect(
    window("session_entry_provenance, acp_owned, plugin_owner_id, hook_external_content_source"),
  ).toEqual({
    session_entry_provenance: provenance,
    acp_owned: provenance,
    plugin_owner_id: provenance ? "plugin-owner" : null,
    hook_external_content_source: provenance ? "webhook" : null,
  });
});

it.each(["transcript-first", "entry-first"] as const)(
  "resolves provenance in the original %s transaction order",
  (order) => {
    const { scope, entry, window, append } = createFixture();
    using _ = vi.spyOn(Date, "now").mockReturnValue(10);
    runOpenClawAgentWriteTransaction((db) => {
      if (order === "transcript-first") {
        append();
      }
      writeSessionEntry(db, scope.sessionKey, entry);
      if (order === "entry-first") {
        append();
      }
    }, scope);
    expect(window("session_entry_provenance, transcript_observed_at")).toEqual({
      session_entry_provenance: order === "transcript-first" ? 0 : 1,
      transcript_observed_at: order === "transcript-first" ? 10 : 20,
    });
  },
);

it.each(["transcript_observed_at", "transcript_updated_at"] as const)(
  "refuses unrepresentable stored %s before writing metadata",
  (column) => {
    const { scope, database, entry, read } = createFixture();
    replaceSessionEntrySync(scope, entry);
    database.db
      .prepare(`UPDATE session_windows SET ${column} = ? WHERE session_id = ?`)
      .run(9_007_199_254_740_993n, entry.sessionId);
    expect(() => replaceSessionEntrySync(scope, { ...entry, label: "must not persist" })).toThrow(
      /too large|safe integer|out of range/i,
    );
    expect(read("session_nodes", "label")).toEqual({ label: null });
  },
);

it.each([
  { type: "human", source: "profile", id: "causal-requester" },
  { type: "agent", id: "main" },
] as const)(
  "keeps legacy actor columns and immutable $type attribution across cold reopen",
  (delegatedBy) => {
    const { scope, entry, read } = createFixture();
    const createdActor = {
      type: "human",
      source: "profile",
      id: "isolation-owner",
      delegatedBy,
    } as const;
    replaceSessionEntrySync(scope, { ...entry, createdActor, sandbox: "required" });
    expect(read("session_nodes", "created_actor_type, created_actor_id")).toEqual({
      created_actor_type: "human",
      created_actor_id: "isolation-owner",
    });
    const first = JSON.parse(String(read("session_nodes", "entry_json")?.entry_json));
    expect(first.createdActor).toEqual(createdActor);
    const publicEntry = projectPublicSessionEntry({ ...entry, createdActor });
    expect(publicEntry.createdActor).toEqual(createdActor.delegatedBy);
    expect(projectExecutionSessionEntry({ ...entry, createdActor }).createdActor).toEqual(
      createdActor,
    );
    replaceSessionEntrySync(scope, { ...publicEntry, updatedAt: 25 });
    expect(
      JSON.parse(String(read("session_nodes", "entry_json")?.entry_json)).createdActor,
    ).toEqual(createdActor);
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    const reopened = openOpenClawAgentDatabase(scope);
    replaceSessionEntrySync(scope, {
      sessionId: entry.sessionId,
      updatedAt: 30,
      label: "post-reopen write",
      createdActor: { type: "agent", id: "cannot-replace-creator" },
    });
    const row = reopened.db
      .prepare("SELECT entry_json, created_actor_id FROM session_nodes WHERE session_key = ?")
      .get(scope.sessionKey);
    expect(row?.created_actor_id).toBe("isolation-owner");
    expect(JSON.parse(String(row?.entry_json))).toMatchObject({
      label: "post-reopen write",
      createdActor,
      sandbox: "required",
    });
  },
);
