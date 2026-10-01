import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { extractSqliteTableSchema } from "../../infra/sqlite-schema-sql.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../../state/openclaw-agent-db-contract.js";
import { assertOpenClawAgentSchemaContains } from "../../state/openclaw-agent-db-schema-helpers.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "../../state/openclaw-agent-schema.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { SessionWorkStartInvalidatedError } from "./lifecycle.js";
import { upsertSessionEntryCore } from "./session-accessor.sqlite-entry.js";
import { copySessionNodeArtifactsForRepair } from "./session-accessor.sqlite-node-artifacts.js";
import {
  replaceTranscriptEvents,
  replaceTranscriptSuffixEventsSync,
} from "./session-accessor.sqlite-transcript-write.js";
import {
  listSessionReactions,
  SessionReactionLimitError,
  SessionReactionMessageMissingError,
  setSessionReaction,
} from "./session-reaction-store.js";

let root: string;
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterAll(async () => {
    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawAgentDatabasesForTest();
    await closeStateDatabaseForTest();
    cleanup();
  }),
);
let scope: { agentId: string; env: NodeJS.ProcessEnv; sessionKey: string };
let sessionIndex = 0;
const reaction = {
  messageId: "message-a",
  emoji: "👍",
  identityId: "alice",
  identityLabel: "Alice",
  expectedSessionId: "session-a",
};

beforeAll(() => {
  root = tempDirs.make("openclaw-session-reactions-");
});

/** Reactions attach to persisted message identities, so every test session carries some. */
async function seedMessages(sessionId: string, messageIds: readonly string[]) {
  await replaceTranscriptEvents({ ...scope, sessionId }, [
    { type: "session", id: sessionId, version: 3 },
    ...messageIds.map((id, index) => ({
      type: "message",
      id,
      parentId: index === 0 ? null : messageIds[index - 1],
      message: { role: "user", content: `Message ${id}` },
    })),
  ]);
}

beforeEach(async () => {
  scope = {
    agentId: "main",
    env: { ...process.env, OPENCLAW_STATE_DIR: root },
    sessionKey: `agent:main:reaction-${sessionIndex++}`,
  };
  await upsertSessionEntryCore(scope, { sessionId: "session-a", updatedAt: 1 });
  await seedMessages("session-a", ["message-a", "message-b", "overflow", "replacement"]);
});

afterEach(() => vi.restoreAllMocks());

describe("session reaction store", () => {
  it("toggles idempotently and summarizes emoji and identities in first-created order", () => {
    vi.spyOn(Date, "now").mockReturnValue(100);
    expect(listSessionReactions(scope, { sessionId: "session-a" })).toEqual({});
    const first = setSessionReaction(scope, reaction);
    expect(first).toEqual({
      reactions: [{ emoji: "👍", count: 1, identities: [{ id: "alice", label: "Alice" }] }],
      changed: true,
    });
    expect(setSessionReaction(scope, reaction)).toEqual({ ...first, changed: false });
    vi.mocked(Date.now).mockReturnValue(200);
    setSessionReaction(scope, { ...reaction, emoji: "🎉" });
    vi.mocked(Date.now).mockReturnValue(300);
    const updated = setSessionReaction(scope, {
      ...reaction,
      identityId: "bob",
      identityLabel: undefined,
    }).reactions;
    expect(updated).toEqual([
      { emoji: "👍", count: 2, identities: [{ id: "alice", label: "Alice" }, { id: "bob" }] },
      { emoji: "🎉", count: 1, identities: [{ id: "alice", label: "Alice" }] },
    ]);
    setSessionReaction(scope, { ...reaction, messageId: "message-b", emoji: "👀" });
    expect(listSessionReactions(scope, { sessionId: "session-a" })).toEqual({
      "message-a": updated,
      "message-b": [{ emoji: "👀", count: 1, identities: [{ id: "alice", label: "Alice" }] }],
    });
    const removed = setSessionReaction(scope, { ...reaction, remove: true }).reactions;
    expect(removed).toEqual([
      { emoji: "🎉", count: 1, identities: [{ id: "alice", label: "Alice" }] },
      { emoji: "👍", count: 1, identities: [{ id: "bob" }] },
    ]);
    expect(setSessionReaction(scope, { ...reaction, remove: true })).toEqual({
      reactions: removed,
      changed: false,
    });
    expect(listSessionReactions(scope, { sessionId: "session-b" })).toEqual({});
  });

  it("caps distinct emoji per identity and message while allowing no-ops and removal", () => {
    for (let index = 0; index < 20; index++) {
      setSessionReaction(scope, { ...reaction, emoji: String.fromCodePoint(0x1f600 + index) });
    }
    expect(() => setSessionReaction(scope, reaction)).toThrow(SessionReactionLimitError);
    expect(() => setSessionReaction(scope, { ...reaction, emoji: "😀" })).not.toThrow();
    expect(() => setSessionReaction(scope, { ...reaction, identityId: "bob" })).not.toThrow();
    expect(() => setSessionReaction(scope, { ...reaction, messageId: "message-b" })).not.toThrow();
    setSessionReaction(scope, { ...reaction, emoji: "😀", remove: true });
    expect(() => setSessionReaction(scope, reaction)).not.toThrow();
  });

  it("admits exactly 5000 rows per session and frees capacity on removal", () => {
    runOpenClawAgentWriteTransaction((database) => {
      const db = getNodeSqliteKysely<Pick<DB, "session_reactions">>(database.db);
      for (let start = 0; start < 4_999; start += 500) {
        executeSqliteQuerySync(
          database.db,
          db.insertInto("session_reactions").values(
            Array.from({ length: Math.min(500, 4_999 - start) }, (_, offset) => ({
              session_key: scope.sessionKey,
              session_id: "session-a",
              message_id: `seed-${start + offset}`,
              emoji: "👍",
              identity_id: "alice",
              identity_label: "Alice",
              created_at: 1,
            })),
          ),
        );
      }
    }, scope);
    const atLimit = setSessionReaction(scope, reaction);
    expect(atLimit.changed).toBe(true);
    expect(setSessionReaction(scope, reaction)).toEqual({ ...atLimit, changed: false });
    expect(() => setSessionReaction(scope, { ...reaction, messageId: "overflow" })).toThrow(
      SessionReactionLimitError,
    );
    setSessionReaction(scope, { ...reaction, remove: true });
    expect(() =>
      setSessionReaction(scope, { ...reaction, messageId: "replacement" }),
    ).not.toThrow();
  });

  it.each(["replacement", "suffix", "incremental suffix"] as const)(
    "prunes deleted-message reactions and frees capacity after transcript %s",
    async (mutation) => {
      const sessionId = `transcript-${sessionIndex}`;
      await upsertSessionEntryCore(scope, { sessionId, updatedAt: 2 });
      const transcriptScope = { ...scope, sessionId };
      const removedReaction = { ...reaction, expectedSessionId: sessionId };
      const events = [
        { type: "session", id: sessionId, version: 3 },
        {
          type: "message",
          id: "retained",
          parentId: null,
          message: { role: "user", content: "Keep this message" },
        },
        {
          type: "message",
          id: reaction.messageId,
          parentId: "retained",
          message: { role: "assistant", content: "Remove this message" },
        },
      ];
      await replaceTranscriptEvents(transcriptScope, events);
      runOpenClawAgentWriteTransaction((database) => {
        const db = getNodeSqliteKysely<Pick<DB, "session_reactions">>(database.db);
        for (let start = 0; start < 4_999; start += 500) {
          executeSqliteQuerySync(
            database.db,
            db.insertInto("session_reactions").values(
              Array.from({ length: Math.min(500, 4_999 - start) }, (_, offset) => ({
                session_key: scope.sessionKey,
                session_id: sessionId,
                message_id: "retained",
                emoji: "👍",
                identity_id: `reader-${start + offset}`,
                identity_label: null,
                created_at: 1,
              })),
            ),
          );
        }
      }, scope);
      setSessionReaction(scope, removedReaction);
      const nextReaction = { ...removedReaction, messageId: "retained", emoji: "👀" };
      expect(() => setSessionReaction(scope, nextReaction)).toThrow(SessionReactionLimitError);

      const retained = events.slice(0, 2);
      if (mutation === "replacement") {
        await replaceTranscriptEvents(transcriptScope, retained);
      } else {
        expect(
          replaceTranscriptSuffixEventsSync(
            transcriptScope,
            events,
            retained,
            mutation === "incremental suffix" ? 2 : 0,
          ),
        ).toBe(true);
      }

      const reactions = listSessionReactions(scope, { sessionId });
      expect(reactions[reaction.messageId]).toBeUndefined();
      expect(reactions.retained).toMatchObject([{ emoji: "👍", count: 4_999 }]);
      expect(setSessionReaction(scope, nextReaction).changed).toBe(true);
      await replaceTranscriptEvents(transcriptScope, []);
      expect(listSessionReactions(scope, { sessionId })).toEqual({});
    },
  );

  it("rejects stale session instances and clears reactions on replacement and node deletion", async () => {
    setSessionReaction(scope, reaction);
    expect(() =>
      setSessionReaction(scope, { ...reaction, expectedSessionId: "session-b" }),
    ).toThrow(SessionWorkStartInvalidatedError);
    await upsertSessionEntryCore(scope, { sessionId: "session-b", updatedAt: 2 });
    await seedMessages("session-b", ["message-a"]);
    expect(listSessionReactions(scope, { sessionId: "session-a" })).toEqual({});
    expect(() => setSessionReaction(scope, reaction)).toThrow(SessionWorkStartInvalidatedError);
    setSessionReaction(scope, { ...reaction, expectedSessionId: "session-b" });
    runOpenClawAgentWriteTransaction((database) => {
      executeSqliteQuerySync(
        database.db,
        getNodeSqliteKysely<Pick<DB, "session_nodes">>(database.db)
          .deleteFrom("session_nodes")
          .where("session_key", "=", scope.sessionKey),
      );
    }, scope);
    expect(listSessionReactions(scope, { sessionId: "session-b" })).toEqual({});
  });

  it("refuses to add a reaction for a message deleted since the caller's read", async () => {
    setSessionReaction(scope, { ...reaction, messageId: "message-b" });
    // The handler read message-a asynchronously; a rewrite removes it before the write.
    await seedMessages("session-a", ["message-b"]);
    expect(() => setSessionReaction(scope, reaction)).toThrow(SessionReactionMessageMissingError);
    expect(setSessionReaction(scope, { ...reaction, remove: true })).toEqual({
      reactions: [],
      changed: false,
    });
    expect(listSessionReactions(scope, { sessionId: "session-a" })).toEqual({
      "message-b": [{ emoji: "👍", count: 1, identities: [{ id: "alice", label: "Alice" }] }],
    });
  });

  it("preserves reaction rows when logical nodes are repaired into a canonical node", async () => {
    const destination = { ...scope, sessionKey: `${scope.sessionKey}-canonical` };
    await upsertSessionEntryCore(destination, { sessionId: "session-a", updatedAt: 1 });
    setSessionReaction(scope, reaction);
    runOpenClawAgentWriteTransaction((database) => {
      copySessionNodeArtifactsForRepair(
        database,
        database,
        [scope.sessionKey],
        destination.sessionKey,
      );
      executeSqliteQuerySync(
        database.db,
        getNodeSqliteKysely<Pick<DB, "session_nodes">>(database.db)
          .deleteFrom("session_nodes")
          .where("session_key", "=", scope.sessionKey),
      );
    }, scope);
    expect(listSessionReactions(destination, { sessionId: "session-a" })).toEqual({
      "message-a": [{ emoji: "👍", count: 1, identities: [{ id: "alice", label: "Alice" }] }],
    });
  });

  it("installs the companion when opening an existing current-version database without it", () => {
    const previousSchema = OPENCLAW_AGENT_SCHEMA_SQL.replace(
      extractSqliteTableSchema(OPENCLAW_AGENT_SCHEMA_SQL, "session_reactions", {
        endMarker: "CREATE TABLE IF NOT EXISTS board_tabs (",
        includeEndMarker: false,
      }),
      "",
    );
    const options = { ...scope, path: path.join(root, "previous-agent.sqlite") };
    const previous = new DatabaseSync(options.path);
    try {
      previous.exec(previousSchema);
      previous.exec(`PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION}`);
      previous
        .prepare(
          "INSERT INTO schema_meta (meta_key, role, schema_version, agent_id, created_at, updated_at) VALUES ('primary', 'agent', ?, 'main', 1, 1)",
        )
        .run(OPENCLAW_AGENT_SCHEMA_VERSION);
    } finally {
      previous.close();
    }
    const database = openOpenClawAgentDatabase(options);
    expect(database.db.prepare("PRAGMA user_version").get()).toEqual({
      user_version: OPENCLAW_AGENT_SCHEMA_VERSION,
    });
    expect(database.db.prepare("SELECT COUNT(*) AS count FROM session_reactions").get()).toEqual({
      count: 0,
    });
    expect(() =>
      assertOpenClawAgentSchemaContains(database.db, database.path, previousSchema),
    ).not.toThrow();
  });
});
