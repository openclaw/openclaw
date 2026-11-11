import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
  observeHostDataSql,
  trackSqliteStatementExecutions,
} from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { assertSqliteSchemaContains as assertSchema } from "../../infra/sqlite-schema-contract.test-support.js";
import { extractSqliteTableSchema } from "../../infra/sqlite-schema-sql.js";
import * as admission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../../state/openclaw-agent-db-contract.js";
import { AGENT_SCHEMA_COMPATIBILITY } from "../../state/openclaw-agent-db-schema-compatibility.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  type OpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "../../state/openclaw-agent-schema.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../runtime-snapshot.js";
import { SessionWorkStartInvalidatedError } from "./lifecycle.js";
import { upsertSessionEntryCore } from "./session-accessor.sqlite-entry.js";
import { copySessionNodeArtifactsForRepair as repairArtifacts } from "./session-accessor.sqlite-node-artifacts.js";
import { replaceTranscriptSuffixEventsSync as replaceSuffix } from "./session-accessor.sqlite-transcript-write.js";
import { replaceTranscriptEvents as replaceTranscript } from "./session-accessor.sqlite-transcript-write.test-support.js";
import {
  SessionReactionLimitError,
  SessionReactionMessageMissingError,
  setSessionReactionAsync,
} from "./session-reaction-store.js";
import { setSessionReactionInDatabase } from "./session-reaction-store.kernel.js";
import { listSessionReactions } from "./session-reaction-store.test-support.js";
import type { StoredMessageReactionSummary } from "./session-reaction-store.types.js";

let root: string;
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterAll(async () => {
    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawAgentDatabasesForTest();
    await closeStateDatabaseForTest();
    cleanup();
    clearRuntimeConfigSnapshot();
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

const alice = { id: "alice", label: "Alice" };
const summary = (
  emoji: string,
  identities: StoredMessageReactionSummary["identities"] = [alice],
) => ({ emoji, count: identities.length, identities });
const result = (
  reactions: StoredMessageReactionSummary[],
  newestRemainingEmoji = reactions.at(-1)?.emoji,
  changed = true,
) => ({ reactions, newestRemainingEmoji, changed });
const react = (overrides: Partial<Parameters<typeof setSessionReactionAsync>[1]> = {}) =>
  setSessionReactionAsync(scope, { ...reaction, ...overrides });
const read = (sessionId = "session-a", target = scope) =>
  listSessionReactions(target, { sessionId });
const upsert = (sessionId = "session-a", updatedAt = 1, target = scope) =>
  upsertSessionEntryCore(target, { sessionId, updatedAt });
const write = <T>(callback: Parameters<typeof runOpenClawAgentWriteTransaction<T>>[0]) =>
  runOpenClawAgentWriteTransaction(callback, scope);
const deleteNode = (database: OpenClawAgentDatabase) =>
  executeSqliteQuerySync(
    database.db,
    getNodeSqliteKysely<Pick<DB, "session_nodes">>(database.db)
      .deleteFrom("session_nodes")
      .where("session_key", "=", scope.sessionKey),
  );

beforeAll(() => {
  root = tempDirs.make("openclaw-session-reactions-");
});

const messages = (sessionId: string, messageIds: readonly string[]) => [
  { type: "session", id: sessionId, version: 3 },
  ...messageIds.map((id, index) => ({
    type: "message",
    id,
    parentId: index === 0 ? null : messageIds[index - 1],
    message: { role: "user", content: `Message ${id}` },
  })),
];
const seedMessages = (sessionId: string, ids: readonly string[]) =>
  replaceTranscript({ ...scope, sessionId }, messages(sessionId, ids));

function stampReaction(emoji: string, identityId: string, createdAt: number) {
  write((database) =>
    executeSqliteQuerySync(
      database.db,
      getNodeSqliteKysely<Pick<DB, "session_reactions">>(database.db)
        .updateTable("session_reactions")
        .set({ created_at: createdAt })
        .where("session_key", "=", scope.sessionKey)
        .where("message_id", "=", reaction.messageId)
        .where("emoji", "=", emoji)
        .where("identity_id", "=", identityId),
    ),
  );
}

beforeEach(async () => {
  scope = {
    agentId: "main",
    env: { ...process.env, OPENCLAW_STATE_DIR: root },
    sessionKey: `agent:main:reaction-${sessionIndex++}`,
  };
  setRuntimeConfigSnapshot({});
  await upsert();
  await seedMessages("session-a", ["message-a", "message-b", "overflow", "replacement"]);
});

afterEach(() => vi.restoreAllMocks());

it("writes shared reactions through their database owner", async () => {
  scope = { ...scope, storePath: path.join(root, "shared-reactions.sqlite") };
  await upsert();
  await seedMessages("session-a", [reaction.messageId]);
  const hostSql = observeHostDataSql();
  expect(await react()).toEqual(result([summary("👍")]));
  expect(hostSql.queries).toEqual([]);
  hostSql.restore();
  expect(read()[reaction.messageId]).toEqual([summary("👍")]);
});

it("adds a reaction with one combined quota and current-message read", () => {
  write((database) => {
    const counter = trackSqliteStatementExecutions(
      requireNativeSqliteDatabase(database.db),
      ["admission"],
      (sql) =>
        /^select/i.test(sql) && /\b(?:session_reactions|transcript_event_identities)\b/i.test(sql)
          ? "admission"
          : null,
    );
    try {
      expect(setSessionReactionInDatabase(database, scope.sessionKey, reaction)).toEqual(
        result([summary("👍")]),
      );
      expect(counter.counts.admission).toBe(2);
    } finally {
      counter.restore();
    }
  });
});

it("rolls back a reaction when the caller's authority expires at commit admission", async () => {
  let current = true;
  probe.admission(admission, (request, grant, callback) => {
    if (request.stage === "commit") {
      current = false;
    }
    return callback(request, grant);
  });
  await expect(
    react({
      assertCurrent() {
        if (!current) {
          throw new Error("Reaction authority revoked");
        }
      },
    }),
  ).rejects.toThrow("Reaction authority revoked");
  expect(current).toBe(false);
  expect(read()).toEqual({});
});

it.each([
  {
    identityId: "alice",
    remaining: [summary("🎉"), summary("👍", [{ id: "bob" }])],
    newest: "👍",
  },
  { identityId: "bob", remaining: [summary("👍"), summary("🎉")], newest: "🎉" },
])(
  "toggles idempotently and retains first-created order after removing $identityId",
  async ({ identityId, remaining, newest }) => {
    expect(read()).toEqual({});
    const first = await react();
    expect(first).toEqual(result([summary("👍")]));
    expect(await react()).toEqual({ ...first, changed: false });
    stampReaction("👍", "alice", 100);
    await react({ emoji: "🎉" });
    stampReaction("🎉", "alice", 200);
    const updated = (await react({ identityId: "bob", identityLabel: undefined })).reactions;
    stampReaction("👍", "bob", 300);
    expect(updated).toEqual([
      { emoji: "👍", count: 2, identities: [alice, { id: "bob" }] },
      summary("🎉"),
    ]);
    await react({ messageId: "message-b", emoji: "👀" });
    expect(read()).toEqual({
      "message-a": updated,
      "message-b": [summary("👀")],
    });
    const removal = { identityId, remove: true };
    expect(await react(removal)).toEqual(result(remaining, newest));
    expect(read()[reaction.messageId]).toEqual(remaining);
    expect(await react(removal)).toEqual(result(remaining, newest, false));
    expect(read("session-b")).toEqual({});
  },
);

it("returns committed reaction rows in SQLite order when timestamps tie", () => {
  vi.spyOn(Date, "now").mockReturnValue(400);
  const set = (params: typeof reaction) =>
    write((database) => setSessionReactionInDatabase(database, scope.sessionKey, params));
  set({ ...reaction, emoji: "😀", identityId: "😀" });
  set({ ...reaction, emoji: "\uE000", identityId: "\uE000" });
  const actual = set({ ...reaction, emoji: "😀", identityId: "\uE000" });
  const expected = [
    summary("\uE000", [{ id: "\uE000", label: "Alice" }]),
    summary(
      "😀",
      ["\uE000", "😀"].map((id) => ({ id, label: "Alice" })),
    ),
  ];
  expect(actual).toEqual(result(expected, "😀"));
  expect(read()[reaction.messageId]).toEqual(expected);
});

it("caps distinct emoji per identity and message while allowing no-ops and removal", async () => {
  for (let index = 0; index < 20; index++) {
    await react({ emoji: String.fromCodePoint(0x1f600 + index) });
  }
  await expect(react()).rejects.toThrow(SessionReactionLimitError);
  await expect(react({ emoji: "😀" })).resolves.toMatchObject({ changed: false });
  await expect(react({ identityId: "bob" })).resolves.toMatchObject({ changed: true });
  await expect(react({ messageId: "message-b" })).resolves.toMatchObject({ changed: true });
  await react({ emoji: "😀", remove: true });
  await expect(react()).resolves.toMatchObject({ changed: true });
});

it.each(["reaction removal", "replacement", "suffix", "incremental suffix"] as const)(
  "enforces 5000 session reactions and frees capacity after %s",
  async (mutation) => {
    const sessionId = `transcript-${sessionIndex}`;
    await upsert(sessionId, 2);
    const transcriptScope = { ...scope, sessionId };
    const set = (overrides: Parameters<typeof react>[0] = {}) =>
      react({ expectedSessionId: sessionId, ...overrides });
    const events = messages(sessionId, ["retained", reaction.messageId]);
    await replaceTranscript(transcriptScope, events);
    write((database) => {
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
    });
    const atLimit = await set();
    expect(atLimit.changed).toBe(true);
    expect(await set()).toEqual({ ...atLimit, changed: false });
    const nextReaction = { messageId: "retained", emoji: "👀" };
    await expect(set(nextReaction)).rejects.toThrow(SessionReactionLimitError);
    await expect(set({ messageId: "missing" })).rejects.toThrow(SessionReactionLimitError);

    const retained = events.slice(0, 2);
    if (mutation === "reaction removal") {
      await set({ remove: true });
    } else if (mutation === "replacement") {
      await replaceTranscript(transcriptScope, retained);
    } else {
      const offset = mutation === "incremental suffix" ? 2 : 0;
      expect(replaceSuffix(transcriptScope, events, retained, offset)).toBe(true);
    }

    const reactions = read(sessionId);
    expect(reactions[reaction.messageId]).toBeUndefined();
    expect(reactions.retained).toMatchObject([{ emoji: "👍", count: 4_999 }]);
    expect((await set(nextReaction)).changed).toBe(true);
    await replaceTranscript(transcriptScope, []);
    expect(read(sessionId)).toEqual({});
  },
);

it("rejects stale session instances and clears reactions on replacement and node deletion", async () => {
  await react();
  await expect(react({ expectedSessionId: "session-b" })).rejects.toThrow(
    SessionWorkStartInvalidatedError,
  );
  await upsert("session-b", 2);
  await seedMessages("session-b", ["message-a"]);
  expect(read()).toEqual({});
  await expect(react()).rejects.toThrow(SessionWorkStartInvalidatedError);
  await react({ expectedSessionId: "session-b" });
  write(deleteNode);
  expect(read("session-b")).toEqual({});
});

it("refuses to add a reaction for a message deleted since the caller's read", async () => {
  await react({ messageId: "message-b" });
  // The handler read message-a asynchronously; a rewrite removes it before the write.
  await seedMessages("session-a", ["message-b"]);
  await expect(react()).rejects.toThrow(SessionReactionMessageMissingError);
  expect(await react({ remove: true })).toEqual(result([], undefined, false));
  expect(read()).toEqual({ "message-b": [summary("👍")] });
});

it("preserves reaction rows when logical nodes are repaired into a canonical node", async () => {
  const destination = { ...scope, sessionKey: `${scope.sessionKey}-canonical` };
  await upsert("session-a", 1, destination);
  await react();
  write((database) => {
    repairArtifacts(database, database, [scope.sessionKey], destination.sessionKey);
    deleteNode(database);
  });
  expect(read("session-a", destination)).toEqual({ "message-a": [summary("👍")] });
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
    assertSchema(
      requireNativeSqliteDatabase(database.db),
      database.path,
      previousSchema,
      AGENT_SCHEMA_COMPATIBILITY,
    ),
  ).not.toThrow();
});
