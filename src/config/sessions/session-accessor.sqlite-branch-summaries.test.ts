import assert from "node:assert/strict";
import { afterEach, expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import * as sqliteRuntime from "../../infra/node-sqlite.js";
import { admitSqliteSchema } from "../../infra/sqlite-schema-facts.js";
import { runSqliteImmediateTransactionSync } from "../../infra/sqlite-transaction.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../runtime-snapshot.js";
import {
  appendTranscriptMessage,
  listSessionBranches,
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "./session-accessor.js";
import {
  branchMessage as message,
  branchSummary as branch,
  expectBranchList,
} from "./session-accessor.sqlite-branch-fixtures.test-support.js";
import {
  readSessionBranchSnapshot,
  readSessionBranchSummariesInWorker,
} from "./session-accessor.sqlite-branches.worker.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import { replaceTranscriptEventsSync } from "./session-accessor.sqlite-transcript-write.test-support.js";
import type { SessionBranchSummary } from "./session-accessor.types.js";
import { createTranscriptEventInserter, prepareTranscriptPayload } from "./transcript-payload.js";

const tempDirs = createTempDirTracker();

afterEach(async () => {
  vi.restoreAllMocks();
  for (const stateDir of tempDirs.dirs) {
    await cleanupSessionStateForTest({ stateDir });
  }
  tempDirs.cleanup();
  clearRuntimeConfigSnapshot();
});

function leaf(
  id: string,
  parentId: string,
  targetId: string,
  fields: Record<string, unknown> = {},
) {
  return { type: "leaf", id, parentId, targetId, ...fields };
}

const cases: Array<{
  name: string;
  events: Record<string, unknown>[];
  branches: SessionBranchSummary[];
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
      leaf("selected", "root", "cycle-message"),
    ],
    branches: [branch("cycle-message", "", 0, true), branch("root", "root", 1)],
  },
  {
    name: "duplicate tip occurrences use the final record without reordering",
    events: [
      message("root", null, "root"),
      message("duplicate", "root", "old", { appendMode: "side", timestamp: "old time" }),
      message("middle", "root", "middle", { appendMode: "side" }),
      message("duplicate", "root", "new", { appendMode: "side", timestamp: "  new time  " }),
    ],
    branches: [
      branch("root", "root", 1, true),
      branch("duplicate", "new", 2, false, "  new time  "),
      branch("middle", "middle", 2),
      branch("duplicate", "new", 2, false, "  new time  "),
    ],
  },
  {
    name: "duplicate IDs can change from message to leaf control",
    events: [
      message("root", null, "root"),
      message("duplicate", "root", "discarded payload", { appendMode: "side" }),
      leaf("duplicate", "root", "root", { timestamp: "  marker time  " }),
      message("tail", "duplicate", "tail"),
    ],
    branches: [
      branch("tail", "tail", 2, true),
      branch("duplicate", "root", 1, false, "  marker time  "),
    ],
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
      leaf("selected", "opaque", "parentless", { appendParentId: "opaque" }),
      message("next", "opaque", "next"),
      leaf("invalid-control", "next", "root", { appendParentId: "missing" }),
      message("child", "invalid-control", "child"),
      { type: "reset", id: "reset", parentId: "child" },
      leaf("old-control", "reset", "root"),
      message("fresh", null, "fresh"),
    ],
    branches: [branch("fresh", "fresh", 5, true), branch("opaque", "continuation", 2)],
  },
  {
    name: "headlines count messages and preserve phase and timestamp rules",
    events: [
      message("root", null, [
        { type: "text", text: "user " },
        { type: "text", text: "joined" },
      ]),
      message("analysis", "root", "not the headline", { role: "assistant", phase: "commentary" }),
      message("answer", "analysis", "## **final**\n  [answer](https://example.com) ", {
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
      message(
        "joined",
        "root",
        [
          { type: "text", text: "café" },
          { type: "text", text: "🦞" },
        ],
        {
          appendMode: "side",
        },
      ),
    ],
    branches: [
      branch("custom", "final answer", 5, true, "  exact timestamp  "),
      branch("joined", "café🦞", 2),
    ],
  },
];

async function seedStoredBranchEvents(events: Record<string, unknown>[], canonical = false) {
  setRuntimeConfigSnapshot({});
  const agentId = "main";
  const env = { ...process.env, OPENCLAW_STATE_DIR: tempDirs.make("openclaw-branch-summary-") };
  const scope = {
    agentId,
    env,
    sessionId: "branch-summary",
    sessionKey: "agent:main:branch-summary",
  };
  await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
  const header = { type: "session", id: scope.sessionId, version: 3 };
  expect(replaceTranscriptEventsSync(scope, canonical ? [header, ...events] : [header])).toBe(true);
  // Seed stored rows directly so append-time deduplication cannot erase reader compatibility cases.
  if (!canonical && events.length) {
    runOpenClawAgentWriteTransaction(
      ({ db }) => {
        createTranscriptEventInserter(db, scope.sessionId).batch(
          events.map((event, index) => ({
            seq: index + 2,
            eventJson: JSON.stringify(event),
            createdAt: 1,
          })),
        );
      },
      { agentId, env },
    );
  }
  return scope;
}

it.each(cases)("$name", async ({ events, branches }) => {
  const scope = await seedStoredBranchEvents(events);
  await expectBranchList(scope, branches);
  expect((await loadTranscriptEvents(scope)).slice(1)).toEqual(events);
});

const seedCanonicalBranchEvents = (events: Record<string, unknown>[]) =>
  seedStoredBranchEvents(events, true);

function branchSnapshot(
  scope: Awaited<ReturnType<typeof seedStoredBranchEvents>>,
  appendSafe: boolean,
) {
  const database = openOpenClawAgentDatabase(scope);
  const previous = readSessionBranchSnapshot(database, scope);
  assert(previous.status === "ok");
  expect(previous.appendSafe).toBe(appendSafe);
  return { database, read: () => readSessionBranchSnapshot(database, { ...scope, previous }) };
}

it("extends a selected ancestor while retaining its inactive descendants and headline", async () => {
  const events = [
    message("root", null, "root headline", { timestamp: "old time" }),
    message("side", "root", "side headline", { appendMode: "side" }),
    leaf("selected", "side", "root"),
  ];
  const scope = await seedCanonicalBranchEvents(events);
  await expect(listSessionBranches(scope)).resolves.toMatchObject({
    status: "ok",
    branches: [
      { leafEntryId: "root", active: true },
      { leafEntryId: "side", active: false },
    ],
  });
  await appendTranscriptMessage(scope, {
    eventId: "tool",
    parentId: "root",
    now: 2_000,
    message: { role: "toolResult", content: "tool result" },
  });
  await appendTranscriptMessage(scope, {
    eventId: "analysis",
    parentId: "tool",
    now: 3_000,
    message: { role: "assistant", content: "hidden", phase: "commentary" },
  });
  await expectBranchList(scope, [
    branch("analysis", "root headline", 3, true, "1970-01-01T00:00:03.000Z"),
    branch("side", "side headline", 2),
  ]);
});

it("rescans when an append resolves an older opaque forward reference", async () => {
  const scope = await seedCanonicalBranchEvents([
    message("root", null, "root headline"),
    { type: "extension", id: "forward", parentId: "future" },
  ]);
  await expect(listSessionBranches(scope)).resolves.toMatchObject({
    status: "ok",
    branches: [
      { leafEntryId: "root", messageCount: 1, active: true },
      { leafEntryId: "forward", messageCount: 0, active: false },
    ],
  });
  await appendTranscriptMessage(scope, {
    eventId: "future",
    parentId: "root",
    now: 1_000,
    message: { role: "user", content: "new headline" },
  });
  await expectBranchList(scope, [
    branch("future", "new headline", 2, true, "1970-01-01T00:00:01.000Z"),
    branch("forward", "new headline", 2),
  ]);
});

it("reads only the newest usable appended headline while retaining cached history", async () => {
  const scope = await seedCanonicalBranchEvents([message("root", null, "original headline")]);
  const { database, read } = branchSnapshot(scope, true);
  let parentId = "root";
  for (const [eventId, content, role, phase] of [
    ["superseded", "large superseded body ".repeat(1_000), "user", undefined],
    ["answer", "latest visible answer", "assistant", "final_answer"],
    ["empty", "  ", "user", undefined],
    ["commentary", "not a headline", "assistant", "commentary"],
    ["tool", "tool payload", "toolResult", undefined],
  ] as const) {
    await appendTranscriptMessage(scope, {
      eventId,
      parentId,
      now: 1_000,
      message: { role, content, ...(phase ? { phase } : {}) },
    });
    parentId = eventId;
  }
  const tracked = trackSqliteStatementExecutions(
    requireNativeSqliteDatabase(database.db),
    ["headlines"],
    (sqlText) =>
      sqlText.includes('from "transcript_events"') &&
      sqlText.includes('as "event_json"') &&
      sqlText.includes('"seq" = ?')
        ? "headlines"
        : null,
  );
  using _ = { [Symbol.dispose]: tracked.restore };
  expect(read()).toMatchObject({
    status: "ok",
    appendSafe: true,
    branches: [branch("tool", "latest visible answer", 6, true)],
  });
  expect(tracked.counts.headlines).toBe(3);
  expect(tracked.textBytes.headlines).toBeLessThan(1_000);
});

it("rescans an unindexed legacy prefix after an append reuses one of its IDs", async () => {
  const scope = await seedStoredBranchEvents([message("legacy", null, "legacy headline")]);
  const { read } = branchSnapshot(scope, false);

  await appendTranscriptMessage(scope, {
    eventId: "legacy",
    parentId: "legacy",
    now: 1_000,
    message: { role: "user", content: "duplicate creates a cycle" },
  });

  expect(read()).toMatchObject({
    status: "ok",
    appendSafe: false,
    branches: [branch("legacy", "", 0, true), branch("legacy", "", 0, true)],
  });
});

it("rejects a malformed unused row before choosing an available headline", async () => {
  const scope = await seedStoredBranchEvents([message("root", null, "available headline")]);
  const database = openOpenClawAgentDatabase(scope);
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
  const database = openOpenClawAgentDatabase(scope);
  const writer = sqliteRuntime.openNodeSqliteDatabase(database.path);
  admitSqliteSchema(writer);
  const request = {
    database: { agentId: scope.agentId, path: database.path },
    sessionKey: scope.sessionKey,
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
            sqlText.includes('from "transcript_events"') &&
            sqlText.includes('as "event_json"') &&
            sqlText.includes('"seq" = ?')
          ) {
            changed = true;
            expect(connection.isTransaction).toBe(true);
            runSqliteImmediateTransactionSync(writer, () => {
              executeSqliteQuerySync(
                writer,
                getSessionKysely(writer)
                  .updateTable("transcript_events")
                  .set(
                    prepareTranscriptPayload(
                      writer,
                      JSON.stringify(message("root", null, "replacement headline")),
                    ),
                  )
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
