import { expect, it } from "vitest";
import { summarizeToolGroup } from "../../lib/chat/tool-call-grouping.ts";
import { coalesceAgentRunFrames } from "./chat-agent-run-grouping.ts";
import { message, nativeMessage, pendingText } from "./chat-thread-fixtures.test-support.ts";
import { buildItems } from "./chat-thread.test-support.ts";
import { coalesceActivityRuns } from "./chat-turn-presentation.ts";

function marker(id: string, runId?: string, itemId?: string, timestamp = 2000) {
  return { role: "system", timestamp, __openclaw: { kind: "compaction", id, runId, itemId } };
}
const rows = (items: ReturnType<typeof buildItems>) =>
  items.flatMap((item) => (item.kind === "group" && item.compaction ? [item.compaction] : []));

it("keeps two compactions in their run with distinct keys across live, settlement and reload", () => {
  const runId = "automatic-run";
  const startedAt = 3000;
  const itemId = "compact-item";
  const messages = [
    nativeMessage("user", "Read the release notes", 1000, { runId, seq: 1 }),
    {
      role: "assistant",
      timestamp: 1500,
      stopReason: "toolUse",
      content: [{ type: "toolCall", id: "read", name: "read", arguments: {} }],
      __openclaw: { runId },
    },
    marker("prior", runId, "prior-item"),
  ];
  const persisted = marker("persisted", runId, itemId, startedAt);
  const savings = { tokensBefore: 756_078, tokensAfter: 80_609 };
  Object.assign(persisted["__openclaw"], savings);
  const terminal = [...messages, persisted];
  const complete = { phase: "complete" as const, runId, itemId, startedAt, completedAt: 4000 };
  const live = buildItems({
    messages,
    runId,
    pendingInputs: [pendingText("Follow up later", 2500)],
    compactionStatus: { ...complete, phase: "active", completedAt: null },
  });
  const settled = buildItems({ messages: terminal, runId, compactionStatus: complete });
  const reload = buildItems({ messages: terminal });
  for (const items of [live, settled, reload]) {
    expect(coalesceActivityRuns(items).find((item) => item.kind === "activity-run")).toMatchObject({
      groups: [{ runId }, { runId, compaction: { runId } }, { runId, compaction: { runId } }],
    });
  }
  const keys = rows(live).map((row) => row.key);
  expect(new Set(keys).size).toBe(2);
  expect(rows(settled).map((row) => row.key)).toEqual(keys);
  expect(rows(reload).map((row) => row.key)).toEqual(keys);
  expect(rows(settled)).toMatchObject([{}, { ...savings, label: "Compacted context" }]);
  expect(rows(settled).map((row) => row.durationMs)).toEqual([undefined, 1000]);
  expect(settled.some((item) => item.kind === "divider")).toBe(false);
});

it("shows an idle manual operation once with tools hidden and does not claim the prior run", () => {
  const runId = "manual-operation";
  const compactionStatus = {
    phase: "complete" as const,
    runId,
    manualOperation: true as const,
    startedAt: 2000,
    completedAt: 3000,
  };
  const messages = [message("assistant", "Done.", 1000), marker("manual", runId)];
  const live = buildItems({ compactionStatus, showToolCalls: false }).at(-1)?.key;
  const items = buildItems({ messages, compactionStatus, showToolCalls: false });
  expect(rows(items)).toMatchObject([{ durationMs: 1000 }]);
  expect(rows(items)[0]?.runId).toBeUndefined();
  expect(coalesceAgentRunFrames(items).at(-1)?.kind).toBe("group");
  expect(items.at(-1)?.key).toBe(live);
  expect(buildItems({ messages, showToolCalls: false }).at(-1)?.key).toBe(live);
});

it("keeps old markers distinct and does not hide fresh itemless progress", () => {
  const runId = "active-run";
  const history = [
    marker("a", "prior-run", "same"),
    marker("b", runId, "same"),
    marker("c", runId, "third"),
  ];
  const status = { runId, startedAt: 3000, completedAt: 4000 };
  const settled = rows(
    buildItems({ messages: history, compactionStatus: { ...status, phase: "complete" } }),
  );
  expect(settled).toHaveLength(3);
  expect(new Set(settled.map((row) => row.key)).size).toBe(3);
  expect(settled.every((row) => row.durationMs === undefined)).toBe(true);
  const active = rows(
    buildItems({
      messages: history.slice(0, 2),
      runId,
      compactionStatus: { ...status, phase: "active", completedAt: null },
    }),
  );
  expect(active.map((row) => row.phase)).toEqual(["complete", "complete", "active"]);
});

it("does not reuse the live group key when a history prepend makes manual matching ambiguous", () => {
  const sessionKey = "agent:main:dashboard:compaction-prepend";
  const runId = "manual-operation";
  const recent = marker("new", runId, undefined, 2000);
  const compactionStatus = {
    phase: "active" as const,
    runId,
    manualOperation: true as const,
    startedAt: 1000,
    completedAt: null,
  };
  expect(buildItems({ sessionKey, messages: [recent], compactionStatus })).toHaveLength(1);
  const prepended = buildItems({
    sessionKey,
    messages: [marker("prior", runId, undefined, 1500), recent],
    compactionStatus,
  });
  expect(prepended).toHaveLength(3);
  expect(new Set(prepended.map((item) => item.key)).size).toBe(3);
  expect(rows(prepended).some((row) => row.phase === "active")).toBe(true);
});

it("keeps six compactions count-free and puts compaction before generic tools", () => {
  const messages = Array.from({ length: 6 }, (_, i) => marker(String(i), "run", String(i)));
  const items = buildItems({ messages, runId: "run" });
  expect(items).toHaveLength(6);
  expect(
    items.every((item) => item.kind === "group" && item.role === "tool" && !item.messages.length),
  ).toBe(true);
  expect(coalesceActivityRuns(items)).toHaveLength(1);
  const operation = (itemId: string, name: string, kind = "tool") => ({
    itemId,
    name,
    title: name,
    kind,
    phase: "end" as const,
    status: "running" as const,
  });
  expect(
    summarizeToolGroup([operation("a", "custom"), operation("b", "compact", "compaction")]),
  ).toBe("Compacting context, using tools");
});

it("renders a legacy context event without changing adjacent messages", () => {
  const items = buildItems({
    messages: [
      message("user", "do it", 1000),
      message("custom", "Context compacted", 2000, {
        customType: "openclaw.context-compaction",
        display: true,
        excludeFromContext: true,
      }),
      message("assistant", "All done.", 3000),
    ],
  });
  expect(items.map((item) => item.kind)).toEqual(["group", "group", "group"]);
  expect(rows(items)).toMatchObject([{ label: "Compacted context" }]);
  expect(items.at(-1)).toMatchObject({ messages: [{ message: { content: "All done." } }] });
});
