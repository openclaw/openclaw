import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { createTranscriptEventReader } from "../../infra/session-sqlite-migration-readers.js";
import * as sqliteDirectories from "../../infra/sqlite-private-directory.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { listSessionBranches } from "./session-accessor.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import { loadExactSessionEntry } from "./session-accessor.sqlite-entry.js";
import { importSqliteSessionRowsBatch } from "./session-accessor.sqlite-import.js";
import {
  importSqliteSessionRows,
  seedUnindexedTranscriptForTest,
} from "./session-accessor.sqlite-import.test-support.js";
import { loadTranscriptEventsSync } from "./session-accessor.sqlite-read.js";
import { runSessionColdStorageMaintenance } from "./session-cold-storage.js";
import { hasSessionTranscriptMessage } from "./session-transcript-message-presence.js";

function target(state: OpenClawTestState, id: string) {
  return {
    agentId: "main",
    env: state.env,
    sessionKey: `agent:main:${id}`,
    storePath: path.join(state.sessionsDir(), "sessions.json"),
    entry: { sessionId: id, updatedAt: 42 },
  };
}
function turn(
  id: string,
  parentId: string | null | undefined,
  role: "user" | "assistant",
  content: string | { type: "text"; text: string }[],
  providerFields: { provider?: string; api?: string } = {},
) {
  return {
    type: "message",
    id,
    ...(parentId === undefined ? {} : { parentId }),
    message: { ...providerFields, role, content },
  };
}
const message = turn("one", null, "user", "preserved");
function header(id: string) {
  return { type: "session", version: 3, id, timestamp: "2026-08-30T00:00:00Z", cwd: "/fixture" };
}
function readEvents(events: unknown[]) {
  return (append: (event: unknown) => void) => events.forEach(append);
}
function importEvents(params: Parameters<typeof importSqliteSessionRows>[0], events: unknown[]) {
  return importSqliteSessionRows({ ...params, readTranscriptEvents: readEvents(events) });
}
function rows(db: OpenClawAgentDatabase["db"], sql: string) {
  return db.prepare(sql).all();
}
function snapshot(db: OpenClawAgentDatabase["db"], ...tables: string[]) {
  return tables.map((table) => rows(db, `SELECT * FROM ${table}`));
}
function textTurn(
  id: string,
  parentId: string | null | undefined,
  role: "user" | "assistant",
  text: string,
) {
  return turn(id, parentId, role, [{ type: "text", text }]);
}
function metadata(id: string, parentId: string, keep: string) {
  return { type: "metadata", id, parentId, payload: { keep } };
}
function leaf(parentId: string, appendParentId: string | null) {
  return { type: "leaf", id: "selection", parentId, targetId: "answer", appendParentId };
}
afterEach(() => vi.restoreAllMocks());

it("preserves a current session introduced after staging while importing unrelated rows", async () => {
  await withOpenClawTestState({ label: "import-current-admission" }, async (state) => {
    const first = target(state, "first");
    const second = target(state, "second");
    const current = { sessionId: "current", updatedAt: 100, label: "Current metadata" };
    await expect(
      importSqliteSessionRowsBatch([
        {
          ...first,
          historicalOnly: true,
          beforePersistentApply: () =>
            runOpenClawAgentWriteTransaction(
              (database) => writeSessionEntry(database, first.sessionKey, current),
              { agentId: "main", env: state.env },
            ),
        },
        { ...second, historicalOnly: true },
      ]),
    ).resolves.toHaveLength(2);
    expect(loadExactSessionEntry(first)?.entry).toMatchObject(current);
    expect(loadExactSessionEntry(second)?.entry.sessionId).toBe("second");
  });
});

// Observe the real allocator on both POSIX and Windows without replacing its permission checks.
function observeStages() {
  const allocation = vi.spyOn(sqliteDirectories, "createPrivateSqliteTempDirectorySync");
  return () =>
    allocation.mock.results.flatMap((result, index) =>
      result.type === "return" && allocation.mock.calls[index]?.[1] === "openclaw-session-import-"
        ? [result.value]
        : [],
    );
}

it("leaves canonical rows unchanged and removes private staging after append failure", async () => {
  await withOpenClawTestState({ label: "import-rollback" }, async (state) => {
    const first = target(state, "first");
    const second = target(state, "second");
    await importEvents(first, [message]);
    const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
    const tables = ["transcript_events", "session_nodes"];
    const before = snapshot(database.db, ...tables);
    const stages = observeStages();
    database.db.exec(`
          CREATE TRIGGER fail_second_import BEFORE INSERT ON transcript_events
          WHEN NEW.session_id = 'second'
          BEGIN SELECT RAISE(ABORT, 'injected append failure'); END;
        `);
    await expect(
      importSqliteSessionRowsBatch([
        {
          ...first,
          entry: { ...first.entry, updatedAt: 100 },
          readTranscriptEvents: readEvents([{ ...message, id: "two", parentId: "one" }]),
        },
        {
          ...second,
          readTranscriptEvents: (append) => {
            expect(database.db.isTransaction).toBe(false);
            expect(stages()).toHaveLength(1);
            if (process.platform !== "win32") {
              expect(fs.statSync(stages()[0]!).mode & 0o777).toBe(0o700);
              expect(fs.statSync(path.join(stages()[0]!, "transcripts.sqlite")).mode & 0o777).toBe(
                0o600,
              );
            }
            append(message);
          },
        },
      ]),
    ).rejects.toThrow("injected append failure");
    expect(database.db.isTransaction).toBe(false);
    expect(snapshot(database.db, ...tables)).toEqual(before);
    expect(stages().every((dir) => !fs.existsSync(dir))).toBe(true);
  });
});

it("revalidates an earlier source after later batch readers finish", async () => {
  await withOpenClawTestState({ label: "import-source-change" }, async (state) => {
    const first = target(state, "first");
    const filename = await state.writeText(
      "source.jsonl",
      `${JSON.stringify({ type: "session", id: "first", version: 3 })}\n${JSON.stringify(message)}\n`,
    );
    const stages = observeStages();
    await expect(
      importSqliteSessionRowsBatch([
        { ...first, readTranscriptEvents: createTranscriptEventReader(filename, "first") },
        {
          ...target(state, "second"),
          readTranscriptEvents: () => {
            fs.appendFileSync(filename, "{}\n");
          },
        },
      ]),
    ).rejects.toThrow("Legacy transcript changed during import");
    expect(loadExactSessionEntry(first)).toBeUndefined();
    expect(stages().every((dir) => !fs.existsSync(dir))).toBe(true);
  });
});

it("refuses imports into archived history without replacing its owner or saved bytes", async () => {
  await withOpenClawTestState({ label: "import-cold-history" }, async (state) => {
    const params = target(state, "old");
    await importEvents(params, [{ ...message, timestamp: 1 }]);
    await importSqliteSessionRows({ ...params, entry: { sessionId: "current", updatedAt: 100 } });
    const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
    database.db
      .prepare(
        "UPDATE session_windows SET updated_at = 1, transcript_updated_at = 1 WHERE session_id = ?",
      )
      .run(params.entry.sessionId);
    await expect(
      runSessionColdStorageMaintenance({
        config: {
          agents: { entries: { main: {} } },
          session: {
            store: database.path,
            maintenance: { coldStorage: { enabled: true, afterDays: 30 } },
          },
        },
      }),
    ).resolves.toMatchObject({ archivedTranscripts: 1 });
    const tables = ["session_nodes", "session_transcript_cold_archives", "transcript_events"];
    const before = snapshot(database.db, ...tables);
    expect(
      rows(database.db, "SELECT * FROM transcript_events WHERE session_id = 'old'"),
    ).not.toHaveLength(0);
    await expect(importEvents(params, [{ replacement: true }])).rejects.toMatchObject({
      code: "TRANSCRIPT_COLD",
    });
    expect(snapshot(database.db, ...tables)).toEqual(before);
  });
});

it("deduplicates existing and incoming bytes and identities, preserves aliases, and reruns idempotently", async () => {
  await withOpenClawTestState({ label: "import-dedupe" }, async (state) => {
    const params = {
      ...target(state, "dedupe"),
      sessionKey: "agent:main:ALIAS",
      preserveExactStoredKey: true,
    };
    const first = { ...message, timestamp: 10 };
    const second = { ...message, id: "two", parentId: "one", timestamp: 30 };
    const rejected = { ...second, timestamp: 99 };
    const opaque = { custom: "no identity", timestamp: 25 };
    const readTranscriptEvents = readEvents([
      first,
      first,
      { ...first, timestamp: 20, message: { role: "user", content: "same id loses" } },
      opaque,
      opaque,
      second,
      rejected,
      { ...second, timestamp: 50 },
      rejected,
    ]);
    const stages = observeStages();
    await importEvents(params, [first]);
    const db = openOpenClawAgentDatabase({ agentId: "main", env: state.env }).db;
    db.prepare("UPDATE session_windows SET created_at = 7 WHERE session_id = ?").run(
      params.entry.sessionId,
    );
    const generation = db.prepare("SELECT generation FROM transcript_rewrite_watermarks").get();
    expect(await importSqliteSessionRows({ ...params, readTranscriptEvents })).toMatchObject({
      transcriptEvents: 2,
      sessionKey: params.sessionKey,
    });
    const rerun = await importSqliteSessionRows({ ...params, readTranscriptEvents });
    expect(rerun).toMatchObject({ transcriptEvents: 0 });
    expect(rows(db, "SELECT session_key FROM session_nodes")).toEqual([
      { session_key: params.sessionKey },
    ]);
    expect(
      rows(db, "SELECT seq, created_at, event_json FROM transcript_events ORDER BY seq"),
    ).toEqual(
      [first, opaque, second].map((event, seq) => ({
        seq,
        created_at: event.timestamp,
        event_json: JSON.stringify(event),
      })),
    );
    expect(rows(db, "SELECT event_id FROM transcript_event_identities ORDER BY seq")).toEqual([
      { event_id: "one" },
      { event_id: "two" },
    ]);
    expect(db.prepare("SELECT created_at, updated_at FROM session_windows").get()).toEqual({
      created_at: 7,
      updated_at: 99,
    });
    expect(db.prepare("SELECT generation FROM transcript_rewrite_watermarks").get()).toEqual(
      generation,
    );
    expect(stages().map((dir) => fs.existsSync(dir))).toEqual([false, false, false]);
  });
});

it("keeps legacy Codex assistant rows that precede later transcript rows during repair", async () => {
  await withOpenClawTestState({ label: "import-codex-rows" }, async (state) => {
    const params = target(state, "codex");
    const codexReply = (id: string, parentId: string, content: string) =>
      turn(id, parentId, "assistant", content, {
        provider: id === "reply-1" ? "openai-codex" : "codex",
        api: id === "reply-1" ? "openai-codex-responses" : "openai-chatgpt-responses",
      });
    const events = [
      { type: "session", id: "codex", version: 3 },
      turn("user-1", null, "user", "hi"),
      codexReply("reply-1", "user-1", "a"),
      turn("user-2", "reply-1", "user", "b"),
      codexReply("reply-2", "user-2", "c"),
      turn("user-3", "reply-2", "user", "d"),
    ];

    expect(await importEvents({ ...params, repairLegacyTranscript: true }, events)).toMatchObject({
      transcriptEvents: events.length,
    });

    const normalized = { provider: "openai", api: "openai-chatgpt-responses" };
    expect(loadTranscriptEventsSync({ ...params, sessionId: "codex" })).toMatchObject(
      events.map(({ id }) => (id.startsWith("reply-") ? { id, message: normalized } : { id })),
    );
  });
});

it("reads legacy handoff bytes, duplicate IDs, timestamps and owner without normalization", async () => {
  await withOpenClawTestState({ label: "import-exact" }, async (state) => {
    const params = target(state, "exact");
    const owner = { actor: { type: "human" as const, id: "owner" }, assignedAt: 40 };
    const firstMessage = { ...message, timestamp: "2026-08-30T00:00:01.000Z" };
    const canonicalMessage = {
      ...message,
      timestamp: "2026-08-30T00:00:02.000Z",
      message: { role: "user", content: "canonical duplicate" },
    };
    const events = [
      { seq: 2, created_at: 41, event_json: '{ "type": "session", "id": "exact", "version": 3 }' },
      { seq: 11, created_at: 43, event_json: JSON.stringify(firstMessage, null, 2) },
      { seq: 17, created_at: 45, event_json: JSON.stringify(canonicalMessage) },
    ];
    await seedUnindexedTranscriptForTest({
      ...params,
      entry: { ...params.entry, owner },
      events: events.map((row) => ({ session_id: params.entry.sessionId, ...row })),
      transcriptMtimeMs: 50,
    });
    const db = openOpenClawAgentDatabase({ agentId: "main", env: state.env }).db;
    expect(
      rows(db, "SELECT seq, created_at, event_json FROM transcript_events ORDER BY seq"),
    ).toEqual(events);
    expect(db.prepare("SELECT count(*) AS count FROM transcript_event_identities").get()).toEqual({
      count: 0,
    });
    expect(loadExactSessionEntry(params)?.entry.owner).toEqual(owner);
    expect(db.prepare("SELECT transcript_updated_at FROM session_windows").get()).toEqual({
      transcript_updated_at: 50,
    });
    expect(loadTranscriptEventsSync({ ...params, sessionId: "exact" })).toHaveLength(3);
    await expect(hasSessionTranscriptMessage({ ...params, sessionId: "exact" })).resolves.toBe(
      true,
    );
    await expect(listSessionBranches(params)).resolves.toEqual({
      status: "ok",
      branches: Array.from({ length: 2 }, () => ({
        leafEntryId: "one",
        headline: "canonical duplicate",
        messageCount: 1,
        updatedAt: canonicalMessage.timestamp,
        active: true,
      })),
    });
  });
});

it("rejects batches spanning implicit agent stores before reading sources", async () => {
  await withOpenClawTestState({ label: "import-store-boundary" }, async (state) => {
    const read = vi.fn();
    await expect(
      importSqliteSessionRowsBatch(
        ["main", "ops"].map((agentId) => ({
          agentId,
          env: state.env,
          sessionKey: `agent:${agentId}:main`,
          entry: { sessionId: agentId, updatedAt: 1 },
          readTranscriptEvents: read,
        })),
      ),
    ).rejects.toThrow("spans multiple stores");
    expect(read).not.toHaveBeenCalled();
  });
});

it.each(["implicit", "root", "opaque"])(
  "repairs an original-only prompt rewrite branch in staging (leaf control=%s)",
  async (mode) => {
    const leafControl = mode !== "implicit";
    await withOpenClawTestState({ label: "import-branch-repair" }, async (state) => {
      const scope = target(state, "repair");
      const hasOpaque = mode === "opaque";
      const parent = textTurn("parent", null, "assistant", "previous");
      const original = textTurn(
        "original",
        leafControl ? "parent" : undefined,
        "user",
        "hello\n\n<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nretired context\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
      );
      const abandoned = textTurn("abandoned", "original", "assistant", "hidden answer");
      const visible = textTurn("visible", leafControl ? "parent" : undefined, "user", "hello");
      const answer = textTurn("answer", "visible", "assistant", "answer");
      const opaque = [
        metadata("append-root", "abandoned", "root"),
        metadata("append-tail", "append-root", "tail"),
      ];
      const postLeaf = metadata("post-leaf", "append-tail", "after");
      const sessionHeader = header("repair");
      const events = [
        sessionHeader,
        ...(leafControl ? [parent, original, abandoned, visible, answer] : [original, visible]),
        ...(hasOpaque ? opaque : []),
        ...(leafControl ? [leaf("abandoned", hasOpaque ? "append-tail" : null)] : []),
        ...(mode === "opaque" ? [postLeaf] : []),
      ];
      const sourceBytes = `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
      const filename = await state.writeText("branch.jsonl", sourceBytes);
      const result = await importSqliteSessionRows({
        ...scope,
        repairLegacyTranscript: true,
        readTranscriptEvents: createTranscriptEventReader(filename, "repair"),
      });
      expect(result.recovery).toMatchObject({ complete: !hasOpaque, repaired: true });
      const transcript = { ...scope, sessionId: "repair" };
      const persisted = loadTranscriptEventsSync(transcript);
      const appendParentId = hasOpaque ? "post-leaf" : leafControl ? null : "visible";
      expect(persisted).toEqual([
        sessionHeader,
        ...(leafControl ? [parent, visible, answer] : [visible]),
        ...(hasOpaque ? [{ ...opaque[0], parentId: "answer" }] : []),
        ...(mode === "opaque" ? [opaque[1], postLeaf] : []),
        ...(leafControl ? [leaf(hasOpaque ? "post-leaf" : "answer", appendParentId)] : []),
      ]);
      const manager = SessionManager.open(transcript, state.workspaceDir);
      expect(manager.buildSessionContext().messages.map((entry) => entry.role)).toEqual(
        leafControl ? ["assistant", "user", "assistant"] : ["user"],
      );
      const nextId = manager.appendMessage({
        role: "user",
        content: "continued",
        timestamp: Date.now(),
      });
      const continued = loadTranscriptEventsSync(transcript);
      expect(continued.slice(0, persisted.length)).toEqual(persisted);
      expect(continued.at(-1)).toMatchObject({
        id: nextId,
        type: "message",
        parentId: appendParentId,
      });
      expect(SessionManager.open(transcript, state.workspaceDir).getLeafId()).toBe(nextId);
      expect(fs.readFileSync(filename, "utf8")).toBe(sourceBytes);
    });
  },
);

it("repairs an identical repeated event and reruns idempotently", async () => {
  const repeated = turn("repeated", "root", "assistant", "same replay");
  await withOpenClawTestState({ label: "import-identical-replay" }, async (state) => {
    const scope = { ...target(state, "replay"), repairLegacyTranscript: true };
    const events = [header("replay"), turn("root", null, "user", "root"), repeated, repeated];
    const imported = await importEvents(scope, events);
    const recovery = { complete: true, events: 3, repaired: true };
    expect(imported).toMatchObject({ recovery, transcriptEvents: 3 });
    expect(
      loadTranscriptEventsSync({ ...scope, sessionId: "replay" }).map(
        (event) => (event as { id?: string }).id,
      ),
    ).toEqual(["replay", "root", "repeated"]);

    const rerun = await importEvents(scope, events);
    expect(rerun).toMatchObject({ recovery, transcriptEvents: 0 });
    const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
    expect(
      rows(
        database.db,
        "SELECT event_id, COUNT(*) AS count FROM transcript_event_identities GROUP BY event_id ORDER BY event_id",
      ),
    ).toEqual(["repeated", "replay", "root"].map((event_id) => ({ event_id, count: 1 })));
  });
});
