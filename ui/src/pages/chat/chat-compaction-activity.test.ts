import { expect, it } from "vitest";
import { summarizeToolGroup } from "../../lib/chat/tool-call-grouping.ts";
import { coalesceAgentRunFrames } from "./chat-agent-run-grouping.ts";
// @vitest-environment node
import { message as chatMessage } from "./chat-thread-fixtures.test-support.ts";
import { buildItems, createProps } from "./chat-thread.test-support.ts";
import { buildCachedChatItems } from "./chat-thread.ts";
import {
  coalesceActivityRuns,
  coalesceStreamRuns,
  collapseCompletedTurnWork,
} from "./chat-turn-presentation.ts";

it("projects repeated compactions into ordinary activity without manufacturing messages", () => {
  const messages = Array.from({ length: 6 }, (_, index) => ({
    role: "system",
    timestamp: 1000 + index,
    __openclaw: {
      id: `compact-${index}`,
      runId: "run-1",
      kind: "compaction",
      tokensBefore: 80000,
      tokensAfter: 20000,
    },
  }));
  const before = JSON.stringify(messages);
  const items = buildItems(createProps({ messages, runId: "run-1" }));
  expect(items.every((item) => item.kind === "group" && item.role === "tool")).toBe(true);
  expect(items.flatMap((item) => (item.kind === "group" ? item.messages : []))).toEqual([]);
  const grouped = coalesceActivityRuns(items);
  expect(grouped).toHaveLength(1);
  expect(grouped[0]?.kind).toBe("activity-run");
  expect(JSON.stringify(messages)).toBe(before);
});

it("keeps an idle manual operation outside agent frames and deduplicates its durable event", () => {
  const status = {
    phase: "complete" as const,
    runId: "manual-operation",
    startedAt: 2000,
    completedAt: 3000,
  };
  const marker = {
    role: "system",
    timestamp: 2000,
    __openclaw: { id: "manual", kind: "compaction", runId: "manual-operation" },
  };
  const messages = [
    { role: "user", content: "Earlier work", timestamp: 500 },
    { role: "assistant", content: "Done.", timestamp: 1000, __openclaw: { runId: "earlier" } },
    marker,
  ];
  for (const showToolCalls of [true, false]) {
    const items = buildItems(createProps({ messages, compactionStatus: status, showToolCalls }));
    const compact = items.filter((item) => item.kind === "group" && item.compaction);
    expect(compact).toHaveLength(1);
    expect(compact[0]).toMatchObject({ role: "tool", messages: [] });
    expect(compact[0]?.kind === "group" && compact[0].compaction?.durationMs).toBe(1000);
    expect(compact[0]?.kind === "group" && compact[0].runId).toBeUndefined();
    expect(coalesceAgentRunFrames(items).at(-1)?.kind).toBe("group");
  }
});

it("keeps live and persisted compaction with its proven tool run", () => {
  const runId = "automatic-run";
  const operation = { runId, itemId: "compact-item", startedAt: 3000 };
  const messages = [
    { role: "user", content: "Read the release notes", timestamp: 1000 },
    {
      role: "assistant",
      timestamp: 2000,
      stopReason: "toolUse",
      content: [{ type: "toolCall", id: "read", name: "read", arguments: {} }],
      __openclaw: { runId },
    },
  ];
  const marker = {
    role: "system",
    timestamp: 3000,
    __openclaw: { runId, itemId: operation.itemId, id: "persisted", kind: "compaction" },
  };
  const live = buildItems(
    createProps({
      messages,
      runId,
      compactionStatus: { ...operation, phase: "active", completedAt: null },
    }),
  );
  const settled = buildItems(
    createProps({
      messages: [...messages, marker],
      runId,
      compactionStatus: { ...operation, phase: "complete", completedAt: 4000 },
    }),
  );
  const reload = buildItems(createProps({ messages: [...messages, marker] }));
  for (const items of [live, settled, reload]) {
    const activity = coalesceActivityRuns(items).find((item) => item.kind === "activity-run");
    expect(activity).toMatchObject({ groups: [{ runId }, { runId, compaction: { runId } }] });
  }
});

it("describes repeated compaction without counters and preserves main's tool summary rules", () => {
  const operation = (
    itemId: string,
    kind: string,
    name?: string,
    status: "completed" | "running" = "completed",
  ) => ({
    itemId,
    kind,
    name,
    title: "Operation",
    phase: "end" as const,
    status,
  });
  const compactions = [operation("c1", "compaction"), operation("c2", "compaction")];
  expect(
    summarizeToolGroup([
      operation("other", "tool", "custom_tool"),
      ...compactions,
      operation("read", "tool", "read"),
      operation("edit", "tool", "edit"),
      operation("cmd", "tool", "exec"),
    ]),
  ).toBe("Read and changed files, ran commands, compacted context");
  expect(summarizeToolGroup(compactions)).toBe("Compacted context");
  expect(
    summarizeToolGroup([
      operation("other", "tool", "custom_tool", "running"),
      ...compactions,
      operation("c3", "compaction", undefined, "running"),
    ]),
  ).toBe("Compacting context, using tools");
});

const collapsedItems = (props: Parameters<typeof createProps>[0]) =>
  collapseCompletedTurnWork(coalesceStreamRuns(buildCachedChatItems(createProps(props))), {
    sessionKey: "agent:main:dashboard:test-session",
    runWorking: false,
  });

it.each(["context event", "persisted boundary"])("renders a compaction %s", (source) => {
  const boundary = source === "persisted boundary";
  const marker = boundary
    ? {
        role: "system",
        timestamp: 2_000,
        __openclaw: {
          kind: "compaction",
          id: "checkpoint-with-metrics",
          tokensBefore: 900_000,
          tokensAfter: 24_700,
        },
      }
    : chatMessage("custom", "Context compacted", 2_000, {
        customType: "openclaw.context-compaction",
        display: true,
        excludeFromContext: true,
        details: { runId: "run-1" },
        idempotencyKey: "codex-context-compaction:thread:turn:item",
      });
  const items = collapsedItems({
    messages: boundary
      ? [marker]
      : [chatMessage("user", "do it", 1_000), marker, chatMessage("assistant", "All done.", 3_000)],
  });
  expect(items[boundary ? 0 : 1]).toMatchObject(
    boundary
      ? {
          kind: "group",
          compaction: {
            phase: "complete",
            label: "Compacted context",
            metric: "saved 875.3k tokens (97.3%)",
          },
        }
      : { kind: "group", compaction: { phase: "complete", label: "Compacted context" } },
  );
  if (!boundary) {
    expect(items.map((item) => item.kind)).toEqual(["group", "group", "group"]);
    expect(items[2]?.kind === "group" ? items[2].messages[0]?.message : null).toMatchObject({
      content: "All done.",
    });
  }
});
