import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import * as sqliteRuntime from "../../infra/node-sqlite.js";
import { runSqliteImmediateTransactionSync } from "../../infra/sqlite-transaction.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  listSessionBranches,
  loadSessionEntry,
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "./session-accessor.js";
import { readSessionBranchSummariesInWorker } from "./session-accessor.sqlite-branches.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import { replaceTranscriptEventsSync } from "./session-accessor.sqlite-transcript-write.js";
import type { SessionBranchListResult } from "./session-accessor.types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  vi.restoreAllMocks();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

function message(
  id: string,
  parentId: string | null,
  content: unknown,
  options: { role?: string; phase?: string; appendMode?: string; timestamp?: string } = {},
): Record<string, unknown> {
  const { role = "user", phase, ...eventFields } = options;
  return {
    type: "message",
    id,
    parentId,
    message: { role, content, ...(phase ? { phase } : {}) },
    ...eventFields,
  };
}

const cases: Array<{
  name: string;
  events: Record<string, unknown>[];
  expected: SessionBranchListResult;
}> = [
  {
    name: "validates a cycle before accepting its leaf's nonempty text",
    events: [
      message("root", null, "root"),
      { type: "extension", id: "cycle-parent", parentId: "cycle-message" },
      message("cycle-message", "cycle-parent", "must not bypass the cycle", {
        role: "assistant",
        appendMode: "side",
      }),
      { type: "leaf", id: "selected", parentId: "root", targetId: "cycle-message" },
    ],
    expected: {
      status: "ok",
      branches: [
        { leafEntryId: "cycle-message", headline: "", messageCount: 0, active: true },
        { leafEntryId: "root", headline: "root", messageCount: 1, active: false },
      ],
    },
  },
  {
    name: "duplicate tip occurrences use the final record without reordering",
    events: [
      message("root", null, "root"),
      message("duplicate", "root", "old", { appendMode: "side", timestamp: "old time" }),
      message("middle", "root", "middle", { appendMode: "side" }),
      message("duplicate", "root", "new", { appendMode: "side", timestamp: "  new time  " }),
    ],
    expected: {
      status: "ok",
      branches: [
        { leafEntryId: "root", headline: "root", messageCount: 1, active: true },
        {
          leafEntryId: "duplicate",
          headline: "new",
          messageCount: 2,
          updatedAt: "  new time  ",
          active: false,
        },
        { leafEntryId: "middle", headline: "middle", messageCount: 2, active: false },
        {
          leafEntryId: "duplicate",
          headline: "new",
          messageCount: 2,
          updatedAt: "  new time  ",
          active: false,
        },
      ],
    },
  },
  {
    name: "duplicate IDs can change from message to leaf control",
    events: [
      message("root", null, "root"),
      message("duplicate", "root", "discarded payload", { appendMode: "side" }),
      {
        type: "leaf",
        id: "duplicate",
        parentId: "root",
        targetId: "root",
        timestamp: "  marker time  ",
      },
      message("tail", "duplicate", "tail"),
    ],
    expected: {
      status: "ok",
      branches: [
        { leafEntryId: "tail", headline: "tail", messageCount: 2, active: true },
        {
          leafEntryId: "duplicate",
          headline: "root",
          messageCount: 1,
          updatedAt: "  marker time  ",
          active: false,
        },
      ],
    },
  },
  {
    name: "forward opaque parents and cycles keep existing summary behavior",
    events: [
      message("root", null, "root"),
      { type: "extension", id: "forward", parentId: "later", payload: "opaque" },
      { type: "extension", id: "later", parentId: "root" },
      { type: "extension", id: "cycle-a", parentId: "cycle-b" },
      { type: "extension", id: "cycle-b", parentId: "cycle-a" },
      { type: "leaf", id: "selected", parentId: "root", targetId: "cycle-a" },
    ],
    expected: {
      status: "ok",
      branches: [
        { leafEntryId: "cycle-a", headline: "", messageCount: 0, active: true },
        { leafEntryId: "forward", headline: "root", messageCount: 1, active: false },
      ],
    },
  },
  {
    name: "parentless rows and invalid controls retain reset navigation",
    events: [
      message("root", null, "root"),
      {
        type: "message",
        id: "parentless",
        message: { role: "assistant", content: "continuation" },
      },
      message("invalid", "", "must stay hidden"),
      { type: "extension", id: "opaque", parentId: "parentless", payload: "opaque" },
      {
        type: "leaf",
        id: "selected",
        parentId: "opaque",
        targetId: "parentless",
        appendParentId: "opaque",
      },
      message("next", "opaque", "next"),
      {
        type: "leaf",
        id: "invalid-control",
        parentId: "next",
        targetId: "root",
        appendParentId: "missing",
      },
      message("child", "invalid-control", "child"),
      { type: "reset", id: "reset", parentId: "child" },
      { type: "leaf", id: "old-control", parentId: "reset", targetId: "root" },
      message("fresh", null, "fresh"),
    ],
    expected: {
      status: "ok",
      branches: [
        { leafEntryId: "fresh", headline: "fresh", messageCount: 5, active: true },
        { leafEntryId: "opaque", headline: "continuation", messageCount: 2, active: false },
      ],
    },
  },
  {
    name: "headlines count messages and preserve phase and timestamp rules",
    events: [
      message("root", null, [
        { type: "text", text: "user " },
        { type: "text", text: "joined" },
      ]),
      message("analysis", "root", "not the headline", { role: "assistant", phase: "commentary" }),
      message("answer", "analysis", " final\n  answer ", {
        role: "assistant",
        phase: "final_answer",
      }),
      message("tool", "answer", { unrelated: "tool result" }, { role: "toolResult" }),
      { type: "message", id: "malformed", parentId: "tool", message: null },
      {
        type: "custom_message",
        id: "custom",
        parentId: "malformed",
        content: "not a message",
        timestamp: "  exact timestamp  ",
      },
    ],
    expected: {
      status: "ok",
      branches: [
        {
          leafEntryId: "custom",
          headline: "final answer",
          messageCount: 5,
          updatedAt: "  exact timestamp  ",
          active: true,
        },
      ],
    },
  },
  {
    name: "headlines retain 120 code points and truncate only longer values",
    events: [
      message("root", null, "root"),
      message("exact", "root", "🦞".repeat(120), { appendMode: "side" }),
      message("long", "root", "🦞".repeat(121), { appendMode: "side" }),
      message(
        "joined",
        "root",
        [
          { type: "text", text: "café" },
          { type: "text", text: "🦞" },
        ],
        { appendMode: "side" },
      ),
    ],
    expected: {
      status: "ok",
      branches: [
        { leafEntryId: "root", headline: "root", messageCount: 1, active: true },
        { leafEntryId: "joined", headline: "café🦞", messageCount: 2, active: false },
        { leafEntryId: "long", headline: `${"🦞".repeat(119)}…`, messageCount: 2, active: false },
        { leafEntryId: "exact", headline: "🦞".repeat(120), messageCount: 2, active: false },
      ],
    },
  },
];

async function seedStoredBranchEvents(events: Record<string, unknown>[]) {
  const agentId = "main";
  const env = { ...process.env, OPENCLAW_STATE_DIR: tempDirs.make("openclaw-branch-summary-") };
  const scope = {
    agentId,
    env,
    sessionId: "branch-summary",
    sessionKey: "agent:main:branch-summary",
  };
  await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
  expect(
    replaceTranscriptEventsSync(scope, [{ type: "session", id: scope.sessionId, version: 3 }]),
  ).toBe(true);
  // Seed stored rows directly so append-time deduplication cannot erase reader compatibility cases.
  runOpenClawAgentWriteTransaction(
    (database) => {
      executeSqliteQuerySync(
        database.db,
        getSessionKysely(database.db)
          .insertInto("transcript_events")
          .values(
            events.map((event, index) => ({
              session_id: scope.sessionId,
              seq: index + 2,
              event_json: JSON.stringify(event),
              created_at: 1,
            })),
          ),
      );
    },
    { agentId, env },
  );
  return scope;
}

describe("stored branch summary compatibility", () => {
  it.each(cases)("$name", async ({ events, expected }) => {
    const scope = await seedStoredBranchEvents(events);

    await expect(listSessionBranches(scope)).resolves.toEqual(expected);
    expect((await loadTranscriptEvents(scope)).slice(1)).toEqual(events);
  });
});

it("rejects a malformed unused row before choosing an available headline", async () => {
  const scope = await seedStoredBranchEvents([message("root", null, "available headline")]);
  const database = openOpenClawAgentDatabase({ agentId: scope.agentId, env: scope.env });
  executeSqliteQuerySync(
    database.db,
    getSessionKysely(database.db).insertInto("transcript_events").values({
      session_id: scope.sessionId,
      seq: 3,
      event_json: "{invalid",
      created_at: 1,
    }),
  );
  await expect(listSessionBranches(scope)).resolves.toEqual({ status: "failed" });
  expect(database.db.isTransaction).toBe(false);
});

it("uses one snapshot for navigation and lazy headline reads", async () => {
  const scope = await seedStoredBranchEvents([
    message("root", null, "original headline"),
    message("tail", "root", "tool payload", { role: "toolResult" }),
  ]);
  const database = openOpenClawAgentDatabase({ agentId: scope.agentId, env: scope.env });
  const writer = new DatabaseSync(database.path);
  const databaseIdentity = readOpenClawAgentDatabaseIdentity(database).identity;
  if (typeof databaseIdentity !== "string") {
    throw new Error("expected a persisted branch fixture");
  }
  const request = {
    database: { agentId: scope.agentId, path: database.path },
    databaseIdentity,
    sessionKey: scope.sessionKey,
    sessionId: scope.sessionId,
    lifecycleRevision: loadSessionEntry(scope)?.lifecycleRevision,
  };
  const openSqlite = sqliteRuntime.openNodeSqliteDatabase;
  let changed = false;
  const spy = vi
    .spyOn(sqliteRuntime, "openNodeSqliteDatabase")
    .mockImplementation((pathname, options) => {
      const connection = openSqlite(pathname, options);
      if (pathname === database.path && options?.readOnly) {
        const prepare = connection.prepare.bind(connection);
        vi.spyOn(connection, "prepare").mockImplementation((sqlText) => {
          if (
            !changed &&
            sqlText.includes('select "event_json" from "transcript_events"') &&
            sqlText.includes('"seq" = ?')
          ) {
            changed = true;
            expect(connection.isTransaction).toBe(true);
            runSqliteImmediateTransactionSync(writer, () => {
              executeSqliteQuerySync(
                writer,
                getSessionKysely(writer)
                  .updateTable("transcript_events")
                  .set({
                    event_json: JSON.stringify(message("root", null, "replacement headline")),
                  })
                  .where("session_id", "=", scope.sessionId)
                  .where("seq", "=", 2),
              );
              executeSqliteQuerySync(
                writer,
                getSessionKysely(writer)
                  .updateTable("transcript_rewrite_watermarks")
                  .set({ generation: "external-rewrite" })
                  .where("session_id", "=", scope.sessionId),
              );
            });
          }
          return prepare(sqlText);
        });
      }
      return connection;
    });
  try {
    expect(readSessionBranchSummariesInWorker(request)).toMatchObject({
      status: "ok",
      branches: [{ headline: "original headline", messageCount: 2 }],
    });
    expect(changed).toBe(true);
  } finally {
    spy.mockRestore();
    writer.close();
  }
  expect(readSessionBranchSummariesInWorker(request)).toMatchObject({
    status: "ok",
    branches: [{ headline: "replacement headline", messageCount: 2 }],
  });
});
