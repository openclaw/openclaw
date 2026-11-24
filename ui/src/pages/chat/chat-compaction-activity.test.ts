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
    manualOperation: true as const,
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
  const prior = {
    ...marker,
    timestamp: 2500,
    __openclaw: { ...marker["__openclaw"], id: "prior", itemId: "prior-item" },
  };
  const liveMessages = [...messages, prior];
  const live = buildItems({
    messages: liveMessages,
    runId,
    compactionStatus: { ...operation, phase: "active", completedAt: null },
  });
  const settled = buildItems({
    messages: [...liveMessages, marker],
    runId,
    compactionStatus: { ...operation, phase: "complete", completedAt: 4000 },
  });
  const reload = buildItems({ messages: [...liveMessages, marker] });
  const rows = (items: typeof live) => {
    const activity = coalesceActivityRuns(items).find((item) => item.kind === "activity-run");
    if (activity?.kind !== "activity-run") {
      throw new Error("Expected an activity run");
    }
    expect(activity.groups).toMatchObject([
      { runId },
      { runId, compaction: { runId } },
      { runId, compaction: { runId } },
    ]);
    return activity.groups.slice(1).map(({ compaction }) => compaction);
  };
  const liveKeys = rows(live).map((row) => row?.key);
  expect(new Set(liveKeys).size).toBe(2);
  expect(rows(settled).map((row) => row?.key)).toEqual(liveKeys);
  expect(rows(reload).map((row) => row?.key)).toEqual(liveKeys);
  expect(rows(settled).map((row) => row?.durationMs)).toEqual([undefined, 1000]);
});

it("keeps distinct compactions when an older completion does not identify its item", () => {
  const sharedItem = "same-item";
  const messages = ["old-run", "active-run", "active-run"].map((runId, index) => ({
    role: "system",
    timestamp: 1000 + index,
    __openclaw: {
      id: "marker-" + index,
      kind: "compaction",
      runId,
      itemId: index === 2 ? "another-item" : sharedItem,
    },
  }));
  const rows = buildItems({
    messages,
    compactionStatus: {
      phase: "complete",
      runId: "active-run",
      startedAt: 1001,
      completedAt: 1002,
    },
  }).flatMap((item) => (item.kind === "group" && item.compaction ? [item.compaction] : []));
  expect(rows).toHaveLength(3);
  expect(new Set(rows.map((row) => row.key)).size).toBe(3);
  expect(rows.every((row) => row.durationMs === undefined)).toBe(true);
  const active = buildItems({
    messages: messages.slice(0, 2),
    runId: "active-run",
    compactionStatus: {
      phase: "active",
      runId: "active-run",
      startedAt: 1002,
      completedAt: null,
    },
  }).flatMap((item) => (item.kind === "group" && item.compaction ? [item.compaction.phase] : []));
  expect(active).toEqual(["complete", "complete", "active"]);
});

it("does not reuse a live group key for an ambiguous manual history prepend", () => {
  const sessionKey = "agent:main:dashboard:compaction-prepend";
  const runId = "manual-operation";
  const marker = (id: string, timestamp: number) => ({
    role: "system",
    timestamp,
    __openclaw: { kind: "compaction", runId, id },
  });
  const recent = marker("new", 2000);
  const compactionStatus = {
    phase: "active" as const,
    runId,
    manualOperation: true as const,
    startedAt: 1000,
    completedAt: null,
  };
  const visible = buildItems({ sessionKey, messages: [recent], compactionStatus });
  expect(visible).toHaveLength(1);
  const prepended = buildItems({
    sessionKey,
    messages: [marker("earlier", 1500), recent],
    compactionStatus,
  });
  expect(prepended).toHaveLength(3);
  expect(new Set(prepended.map((item) => item.key)).size).toBe(3);
  expect(prepended).toContainEqual(
    expect.objectContaining({
      kind: "group",
      compaction: expect.objectContaining({ phase: "active" }),
    }),
  );
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
