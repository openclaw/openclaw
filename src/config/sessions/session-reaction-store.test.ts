import { existsSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { extractSqliteTableSchema } from "../../infra/sqlite-schema-sql.js";
import * as admission from "../../infra/sqlite-worker-operation-admission.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../../state/openclaw-agent-db-contract.js";
import { assertOpenClawAgentSchemaContains } from "../../state/openclaw-agent-db-schema-helpers.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
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
  setSessionReactionAsync,
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
let scope: { agentId: string; env: NodeJS.ProcessEnv; sessionKey: string; storePath?: string };
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

function stampReaction(emoji: string, identityId: string, createdAt: number) {
  runOpenClawAgentWriteTransaction((database) => {
    executeSqliteQuerySync(
      database.db,
      getNodeSqliteKysely<Pick<DB, "session_reactions">>(database.db)
        .updateTable("session_reactions")
        .set({ created_at: createdAt })
        .where("session_key", "=", scope.sessionKey)
        .where("message_id", "=", reaction.messageId)
        .where("emoji", "=", emoji)
        .where("identity_id", "=", identityId),
    );
  }, scope);
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
  it.each(["default", "shared"] as const)(
    "writes %s reactions without running SQLite on the caller's thread",
    async (store) => {
      if (store === "shared") {
        scope = { ...scope, storePath: path.join(root, "shared-reactions.sqlite") };
        await upsertSessionEntryCore(scope, { sessionId: "session-a", updatedAt: 1 });
        await seedMessages("session-a", [reaction.messageId]);
      }
      const database = openOpenClawAgentDatabase({ ...scope, path: scope.storePath });
      const statementPrototype: StatementSync = Object.getPrototypeOf(
        database.db.prepare("SELECT 1"),
      );
      const databasePrototype: DatabaseSync = Object.getPrototypeOf(database.db);
      const methods = [
        vi.spyOn(statementPrototype, "all"),
        vi.spyOn(statementPrototype, "get"),
        vi.spyOn(statementPrototype, "iterate"),
        vi.spyOn(statementPrototype, "run"),
        vi.spyOn(databasePrototype, "exec"),
      ];
      try {
        expect(await setSessionReactionAsync(scope, reaction)).toEqual({
          reactions: [{ emoji: "👍", count: 1, identities: [{ id: "alice", label: "Alice" }] }],
          newestRemainingEmoji: "👍",
          changed: true,
        });
        for (const method of methods) {
          expect(method).not.toHaveBeenCalled();
        }
      } finally {
        for (const method of methods) {
          method.mockRestore();
        }
      }
      expect(listSessionReactions(scope, { sessionId: "session-a" })[reaction.messageId]).toEqual([
        { emoji: "👍", count: 1, identities: [{ id: "alice", label: "Alice" }] },
      ]);
    },
  );

  it("rolls back a reaction when the caller's authority expires at commit admission", async () => {
    const createAdmission = admission.createSqliteWorkerOperationAdmission;
    let current = true;
    vi.spyOn(admission, "createSqliteWorkerOperationAdmission").mockImplementation(
      (callback, attachment) =>
        createAdmission((request, grant) => {
          if (request.stage === "commit") {
            current = false;
          }
          return callback(request, grant);
        }, attachment),
    );
    await expect(
      setSessionReactionAsync(scope, {
        ...reaction,
        assertCurrent() {
          if (!current) {
            throw new Error("Reaction authority revoked");
          }
        },
      }),
    ).rejects.toThrow("Reaction authority revoked");
    expect(current).toBe(false);
    expect(listSessionReactions(scope, { sessionId: "session-a" })).toEqual({});
  });

  it("keeps incognito reaction writes with their process-held database", async () => {
    scope = { ...scope, sessionKey: `agent:main:dashboard:incognito-reaction-${sessionIndex}` };
    await upsertSessionEntryCore(scope, { sessionId: "session-a", updatedAt: 1, incognito: true });
    await seedMessages("session-a", [reaction.messageId]);
    const admitted = vi.spyOn(admission, "createSqliteWorkerOperationAdmission");
    expect((await setSessionReactionAsync(scope, reaction)).changed).toBe(true);
    expect(listSessionReactions(scope, { sessionId: "session-a" })[reaction.messageId]).toEqual([
      { emoji: "👍", count: 1, identities: [{ id: "alice", label: "Alice" }] },
    ]);
    expect(admitted).not.toHaveBeenCalled();
    expect(existsSync(resolveIncognitoOpenClawAgentSqlitePath(scope))).toBe(false);
  });

  it("toggles idempotently and summarizes emoji and identities in first-created order", async () => {
    expect(listSessionReactions(scope, { sessionId: "session-a" })).toEqual({});
    const first = await setSessionReactionAsync(scope, reaction);
    expect(first).toEqual({
      reactions: [{ emoji: "👍", count: 1, identities: [{ id: "alice", label: "Alice" }] }],
      newestRemainingEmoji: "👍",
      changed: true,
    });
    expect(await setSessionReactionAsync(scope, reaction)).toEqual({ ...first, changed: false });
    stampReaction("👍", "alice", 100);
    await setSessionReactionAsync(scope, { ...reaction, emoji: "🎉" });
    stampReaction("🎉", "alice", 200);
    const updated = (
      await setSessionReactionAsync(scope, {
        ...reaction,
        identityId: "bob",
        identityLabel: undefined,
      })
    ).reactions;
    stampReaction("👍", "bob", 300);
    expect(updated).toEqual([
      { emoji: "👍", count: 2, identities: [{ id: "alice", label: "Alice" }, { id: "bob" }] },
      { emoji: "🎉", count: 1, identities: [{ id: "alice", label: "Alice" }] },
    ]);
    await setSessionReactionAsync(scope, { ...reaction, messageId: "message-b", emoji: "👀" });
    expect(listSessionReactions(scope, { sessionId: "session-a" })).toEqual({
      "message-a": updated,
      "message-b": [{ emoji: "👀", count: 1, identities: [{ id: "alice", label: "Alice" }] }],
    });
    const removed = (await setSessionReactionAsync(scope, { ...reaction, remove: true })).reactions;
    expect(removed).toEqual([
      { emoji: "🎉", count: 1, identities: [{ id: "alice", label: "Alice" }] },
      { emoji: "👍", count: 1, identities: [{ id: "bob" }] },
    ]);
    expect(await setSessionReactionAsync(scope, { ...reaction, remove: true })).toEqual({
      reactions: removed,
      newestRemainingEmoji: "👍",
      changed: false,
    });
    expect(listSessionReactions(scope, { sessionId: "session-b" })).toEqual({});
  });

  it.each([
    {
      name: "removing 🚀 after Alice 👍, Alice 🎉, Bob 👍, then 🚀",
      rocket: true,
      emoji: "🚀",
      identityId: "alice",
      expected: "👍",
    },
    {
      name: "removing Bob's newest 👍 while Alice's older 👍 remains",
      rocket: false,
      emoji: "👍",
      identityId: "bob",
      expected: "🎉",
    },
  ])("returns the newest surviving emoji after $name", async (scenario) => {
    for (const [emoji, identityId, createdAt] of [
      ["👍", "alice", 100],
      ["🎉", "alice", 200],
      ["👍", "bob", 300],
    ] as const) {
      await setSessionReactionAsync(scope, { ...reaction, emoji, identityId });
      stampReaction(emoji, identityId, createdAt);
    }
    if (scenario.rocket) {
      await setSessionReactionAsync(scope, { ...reaction, emoji: "🚀" });
      stampReaction("🚀", "alice", 400);
    }
    const removal = {
      ...reaction,
      emoji: scenario.emoji,
      identityId: scenario.identityId,
      remove: true,
    };
    const result = await setSessionReactionAsync(scope, removal);
    expect(result).toMatchObject({ changed: true, newestRemainingEmoji: scenario.expected });
    expect(result.reactions.map(({ emoji }) => emoji)).toEqual(["👍", "🎉"]);
    expect(await setSessionReactionAsync(scope, removal)).toMatchObject({
      changed: false,
      newestRemainingEmoji: scenario.expected,
    });
  });

  it("caps distinct emoji per identity and message while allowing no-ops and removal", async () => {
    for (let index = 0; index < 20; index++) {
      await setSessionReactionAsync(scope, {
        ...reaction,
        emoji: String.fromCodePoint(0x1f600 + index),
      });
    }
    await expect(setSessionReactionAsync(scope, reaction)).rejects.toThrow(
      SessionReactionLimitError,
    );
    await expect(
      setSessionReactionAsync(scope, { ...reaction, emoji: "😀" }),
    ).resolves.toMatchObject({ changed: false });
    await expect(
      setSessionReactionAsync(scope, { ...reaction, identityId: "bob" }),
    ).resolves.toMatchObject({ changed: true });
    await expect(
      setSessionReactionAsync(scope, { ...reaction, messageId: "message-b" }),
    ).resolves.toMatchObject({ changed: true });
    await setSessionReactionAsync(scope, { ...reaction, emoji: "😀", remove: true });
    await expect(setSessionReactionAsync(scope, reaction)).resolves.toMatchObject({
      changed: true,
    });
  });

  it("admits exactly 5000 rows per session and frees capacity on removal", async () => {
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
    const atLimit = await setSessionReactionAsync(scope, reaction);
    expect(atLimit.changed).toBe(true);
    expect(await setSessionReactionAsync(scope, reaction)).toEqual({ ...atLimit, changed: false });
    await expect(
      setSessionReactionAsync(scope, { ...reaction, messageId: "overflow" }),
    ).rejects.toThrow(SessionReactionLimitError);
    await setSessionReactionAsync(scope, { ...reaction, remove: true });
    await expect(
      setSessionReactionAsync(scope, { ...reaction, messageId: "replacement" }),
    ).resolves.toMatchObject({ changed: true });
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
      await setSessionReactionAsync(scope, removedReaction);
      const nextReaction = { ...removedReaction, messageId: "retained", emoji: "👀" };
      await expect(setSessionReactionAsync(scope, nextReaction)).rejects.toThrow(
        SessionReactionLimitError,
      );

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
      expect((await setSessionReactionAsync(scope, nextReaction)).changed).toBe(true);
      await replaceTranscriptEvents(transcriptScope, []);
      expect(listSessionReactions(scope, { sessionId })).toEqual({});
    },
  );

  it("rejects stale session instances and clears reactions on replacement and node deletion", async () => {
    await setSessionReactionAsync(scope, reaction);
    await expect(
      setSessionReactionAsync(scope, { ...reaction, expectedSessionId: "session-b" }),
    ).rejects.toThrow(SessionWorkStartInvalidatedError);
    await upsertSessionEntryCore(scope, { sessionId: "session-b", updatedAt: 2 });
    await seedMessages("session-b", ["message-a"]);
    expect(listSessionReactions(scope, { sessionId: "session-a" })).toEqual({});
    await expect(setSessionReactionAsync(scope, reaction)).rejects.toThrow(
      SessionWorkStartInvalidatedError,
    );
    await setSessionReactionAsync(scope, { ...reaction, expectedSessionId: "session-b" });
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
    await setSessionReactionAsync(scope, { ...reaction, messageId: "message-b" });
    // The handler read message-a asynchronously; a rewrite removes it before the write.
    await seedMessages("session-a", ["message-b"]);
    await expect(setSessionReactionAsync(scope, reaction)).rejects.toThrow(
      SessionReactionMessageMissingError,
    );
    expect(await setSessionReactionAsync(scope, { ...reaction, remove: true })).toEqual({
      reactions: [],
      newestRemainingEmoji: undefined,
      changed: false,
    });
    expect(listSessionReactions(scope, { sessionId: "session-a" })).toEqual({
      "message-b": [{ emoji: "👍", count: 1, identities: [{ id: "alice", label: "Alice" }] }],
    });
  });

  it("preserves reaction rows when logical nodes are repaired into a canonical node", async () => {
    const destination = { ...scope, sessionKey: `${scope.sessionKey}-canonical` };
    await upsertSessionEntryCore(destination, { sessionId: "session-a", updatedAt: 1 });
    await setSessionReactionAsync(scope, reaction);
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
