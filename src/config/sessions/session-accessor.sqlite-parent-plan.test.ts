import path from "node:path";
import { afterAll, expect, it } from "vitest";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import {
  estimateParentForkPromptTokens,
  resolveParentForkSourceTranscript,
} from "./session-accessor.sqlite-parent-fork.js";
import {
  hydrateSqliteParentForkEvent,
  planSqliteParentForkSource,
} from "./session-accessor.sqlite-parent-plan.js";
import { loadTranscriptEventsFromDatabase } from "./session-accessor.sqlite-read.js";
import { appendTranscriptEventsInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import { isIndexedSessionEntry } from "./session-entry-codec.js";
import { createTranscriptEventInserter } from "./transcript-payload.js";

const dirs = useSessionStoreTempDirs(afterAll, "parent-plan-");
const header = { type: "session", id: "parent", version: 3, cwd: "/synthetic" };
const assistant = (id: string, parentId: string | null, extra = {}) => ({
  type: "message",
  id,
  parentId,
  message: { role: "assistant", content: "body", ...extra },
});
const tool = (id: string, parentId: string, extra = {}) => ({
  type: "message",
  id,
  parentId,
  message: {
    role: "toolResult",
    content: [],
    toolCallId: "call",
    toolName: "test",
    isError: false,
    ...extra,
  },
});
const call = assistant("call", null, {
  content: [{ type: "toolCall", id: "call", name: "test", arguments: { body: "large" } }],
  stopReason: "toolUse",
});
const pending = assistant("pending", "first", {
  provider: "openclaw",
  model: "automation-result",
  excludeFromContext: true,
  openclawModelPlacement: "pending",
  content: "background result body",
  usage: { input: 999999, output: 1 },
});
const placement = {
  type: "custom",
  id: "placement",
  parentId: "pending",
  customType: "openclaw.background-result-placement",
  data: { afterEntryId: "first", resultEntryIds: ["pending"] },
  extra: "projection bytes",
};
const fixtures = {
  background: [header, assistant("first", null), pending, placement],
  backgroundReset: [
    header,
    assistant("first", null),
    pending,
    placement,
    { type: "reset", id: "reset", parentId: "placement", reason: "new", firstKeptEntryId: "first" },
    assistant("unfinished", "reset", { stopReason: "toolUse" }),
  ],
  backgroundCompaction: [
    header,
    assistant("first", null),
    pending,
    placement,
    {
      type: "compaction",
      id: "cut",
      parentId: "placement",
      summary: "summary",
      firstKeptEntryId: "first",
      tokensBefore: 10,
    },
    assistant("last", "cut"),
  ],
  artifactTail: [
    header,
    assistant("first", null),
    assistant("notice", "first", { provider: "openclaw", model: "delivery-notice" }),
    assistant("unfinished", "notice", { stopReason: "toolUse" }),
  ],
  pendingTail: [header, assistant("first", null), pending],
  resetTail: [
    header,
    assistant("first", null),
    { type: "reset", id: "reset", parentId: "first", reason: "new" },
    assistant("unfinished", "reset", { stopReason: "toolUse" }),
  ],
  operators: [
    header,
    assistant("first", null),
    {
      type: "custom_message",
      id: "override",
      parentId: "first",
      customType: "openclaw.system-update",
      content: "old override",
      display: true,
      details: { kind: "prompt-update" },
    },
    {
      type: "custom",
      id: "restart",
      parentId: "override",
      customType: "openclaw.system-prompt",
      data: { restart: true },
    },
    {
      type: "custom_message",
      id: "excluded",
      parentId: "restart",
      customType: "custom",
      content: "excluded",
      display: true,
      excludeFromContext: true,
    },
    assistant("last", "excluded"),
  ],
  linear: [
    header,
    assistant("first", null, { content: "x".repeat(64 * 1024), usage: { input: 10, output: 5 } }),
    { type: "message", id: "parentless", message: { role: "user", content: "tail" } },
    assistant("last", "stale"),
  ],
  compaction: [
    header,
    assistant("first", null),
    { type: "plugin", id: "opaque", parentId: "first", data: "keep" },
    {
      type: "compaction",
      id: "cut",
      parentId: "opaque",
      summary: "summary",
      firstKeptEntryId: "opaque",
      tokensBefore: 100,
    },
    assistant("last", "cut", { usage: { contextUsage: { state: "available", totalTokens: 31 } } }),
  ],
  reset: [
    header,
    call,
    tool("synthetic", "call", {
      isError: true,
      content: [
        {
          type: "text",
          text: "[openclaw] missing tool result in session history; inserted synthetic error result for transcript repair.",
        },
      ],
    }),
    tool("real", "synthetic"),
    { type: "reset", id: "reset", parentId: "real", reason: "new", firstKeptEntryId: "call" },
    assistant("last", "reset", { api: "cli", usage: { input: 100 } }),
  ],
  opaqueToolResult: [
    header,
    call,
    tool("result", "call", { content: [{ type: { toString: null } }] }),
    assistant("last", "result"),
  ],
  legacySyntheticReset: [
    header,
    call,
    tool("synthetic", "call", {
      toolCallId: " ",
      isError: false,
      content: [
        {
          type: "text",
          text: "[openclaw] missing tool result in session history; inserted synthetic error result for transcript repair.",
        },
      ],
    }),
    tool("real", "synthetic"),
    { type: "reset", id: "reset", parentId: "real", reason: "new", firstKeptEntryId: "call" },
    assistant("last", "reset"),
  ],
  branch: [
    header,
    assistant("first", null),
    assistant("hidden", "first"),
    { type: "leaf", id: "select", parentId: "hidden", targetId: "first" },
    { type: "plugin", id: "opaque", parentId: "hidden", payload: "opaque" },
    {
      type: "label",
      id: "label",
      parentId: "opaque",
      targetId: "first",
      label: "chosen",
      timestamp: "2026-01-01",
    },
    {
      type: "leaf",
      id: "side",
      parentId: "label",
      targetId: "first",
      appendParentId: "opaque",
      appendMode: "side",
    },
  ],
  malformed: [
    header,
    assistant("first", null),
    {
      type: "message",
      id: "bad",
      parentId: "first",
      message: { role: "assistant", content: [null] },
    },
    {
      type: "compaction",
      id: "bad-cut",
      parentId: "bad",
      summary: null,
      firstKeptEntryId: "first",
      tokensBefore: 10,
    },
    assistant("last", "bad-cut", { excludeFromContext: true }),
  ],
  duplicate: [
    header,
    assistant("same", null, { content: "earlier" }),
    assistant("same", null, { content: "later" }),
    assistant("last", "same"),
  ],
};

it.each(Object.entries(fixtures))(
  "matches canonical source and exact token estimate: %s",
  (name, events) => {
    const storePath = path.join(dirs.make(), name + ".sqlite");
    const options = { agentId: "main", path: storePath };
    const database = openOpenClawAgentDatabase(options);
    runOpenClawAgentWriteTransaction(() => {
      appendTranscriptEventsInTransaction(
        database,
        { ...options, sessionKey: "agent:main:parent", sessionId: "parent" },
        [header],
      );
      const insert = createTranscriptEventInserter(database.db, "parent");
      // Native payload owner permits duplicate/opaque legacy rows without turning
      // this fixture into an identity-deduplication test.
      events
        .slice(1)
        .forEach((event, index) =>
          insert({ seq: index + 1, eventJson: JSON.stringify(event), createdAt: 1 }),
        );
      const canonical = loadTranscriptEventsFromDatabase(database, "parent");
      for (const forkFrom of [undefined, "last-completed"] as const) {
        const expected = resolveParentForkSourceTranscript(canonical, forkFrom);
        const planned = planSqliteParentForkSource(database, "parent", forkFrom);
        expect(planned).not.toBeNull();
        if (!planned || !expected) {
          throw new Error("missing source");
        }
        if (name === "linear") {
          expect(JSON.stringify(planned.branchEntries)).not.toContain("x".repeat(64 * 1024));
        }
        const hydrate = (event: unknown) => hydrateSqliteParentForkEvent(database, "parent", event);
        expect(planned.branchEntries.map(isIndexedSessionEntry)).toEqual(
          expected.branchEntries.map(isIndexedSessionEntry),
        );
        expect(
          structuredClone({ ...planned, branchEntries: planned.branchEntries.map(hydrate) }),
        ).toEqual(expected);
        expect(estimateParentForkPromptTokens(planned, hydrate)).toBe(
          estimateParentForkPromptTokens(expected),
        );
      }
    }, options);
  },
);

it("rolls back a streamed child header when hydration fails", () => {
  const options = { agentId: "main", path: path.join(dirs.make(), "rollback.sqlite") };
  const database = openOpenClawAgentDatabase(options);
  const scope = { ...options, sessionKey: "agent:main:parent", sessionId: "parent" };
  runOpenClawAgentWriteTransaction(() => {
    appendTranscriptEventsInTransaction(database, scope, [header, assistant("body", null)]);
  }, options);
  expect(() =>
    runOpenClawAgentWriteTransaction(() => {
      const source = planSqliteParentForkSource(database, "parent");
      if (!source) {
        throw new Error("missing source");
      }
      database.db
        .prepare("DELETE FROM transcript_events WHERE session_id = ? AND seq = 1")
        .run("parent");
      appendTranscriptEventsInTransaction(
        database,
        { ...scope, sessionId: "child" },
        (function* () {
          yield { ...header, id: "child" };
          for (const event of source.branchEntries) {
            yield hydrateSqliteParentForkEvent(database, "parent", event);
          }
        })(),
      );
    }, options),
  ).toThrow("Parent fork source row disappeared");
  expect(loadTranscriptEventsFromDatabase(database, "child")).toEqual([]);
  expect(loadTranscriptEventsFromDatabase(database, "parent")).toHaveLength(2);
});
