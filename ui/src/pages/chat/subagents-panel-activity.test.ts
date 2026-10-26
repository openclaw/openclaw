import { expect, it } from "vitest";
import type { AgentActivityItem } from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import type { ChatHistoryResult } from "./chat-history-snapshot.ts";
import { readSubagentActivitySnapshot, subagentToolCallCount } from "./subagents-panel-activity.ts";
import type { AgentEventPayload } from "./tool-stream-contract.ts";

const toolCall = (id: string | undefined = "read-1") => ({
  role: "assistant",
  runId: "run-1",
  content: [{ type: "toolCall", ...(id ? { id } : {}), name: "read" }],
});

const toolResult = () => ({
  role: "toolResult",
  runId: "run-1",
  toolCallId: "read-1",
  content: [{ type: "text", text: "export const ready = true;" }],
});

const activity = (extra: Partial<AgentActivityItem> = {}): AgentActivityItem => ({
  itemId: "item-read-1",
  toolCallId: "read-1",
  kind: "tool",
  name: "read",
  title: "Read file",
  phase: "end",
  status: "completed",
  ...extra,
});

function complete(messages: unknown[], extra: Partial<ChatHistoryResult> = {}): ChatHistoryResult {
  return { messages, hasMore: false, totalMessages: messages.length, ...extra };
}

function event(stream: string, data: AgentEventPayload["data"], seq: number): AgentEventPayload {
  return { runId: "run-1", seq, ts: 1000 + seq, stream, data };
}

const count = (history: ChatHistoryResult) =>
  subagentToolCallCount(readSubagentActivitySnapshot(history));
const live = (events: AgentEventPayload[], messages: unknown[] = []) =>
  complete(messages, { inFlightRun: { runId: "run-1", events } });
const preparedCall = (extra: Partial<AgentActivityItem>) => ({
  ...toolCall(),
  content: [],
  activity: [activity(extra)],
});

it.each<[ChatHistoryResult, ReturnType<typeof count>]>([
  [
    complete([toolCall()], { hasMore: true, nextOffset: 1, totalMessages: 20 }),
    { count: 1, exact: false },
  ],
  [complete([toolCall("")]), undefined],
  [complete([{ ...toolCall(), runId: undefined }]), undefined],
  [complete([preparedCall({ toolCallId: undefined })]), undefined],
  [{}, undefined],
])("reports count certainty for %j", (history, expected) => {
  expect(count(history)).toEqual(expected);
});

it("counts paired transcript calls, results and replayed live items once", () => {
  const history = live(
    [
      event("tool", { toolCallId: "read-1", name: "read", phase: "start" }, 1),
      event("item", activity({ phase: "start", status: "running" }), 2),
      event("tool", { toolCallId: "read-1", name: "read", phase: "result" }, 3),
      event("item", activity(), 4),
    ],
    [toolCall(), toolResult()],
  );
  expect(count(history)).toEqual({ count: 1, exact: true });
});

it("keeps reused call IDs in distinct recorded runs separate while deduplicating each result", () => {
  const history = complete(
    [
      { ...toolCall(), activity: [activity()] },
      toolResult(),
      { ...toolCall(), runId: "run-2", activity: [activity()] },
      { ...toolResult(), runId: "run-2" },
    ],
    {
      inFlightRun: {
        runId: "run-2",
        events: [{ ...event("item", activity(), 1), runId: "run-2" }],
      },
    },
  );
  expect(count(history)).toEqual({ count: 2, exact: true });
});

it("keeps a lower bound when an invocation ID is omitted across item frames", () => {
  const progressText = "Reading source";
  const known = activity({ phase: "update", status: "running", progressText });
  const itemOnly = { ...known, toolCallId: undefined, phase: "start" as const };
  const snapshot = readSubagentActivitySnapshot(
    live([known, itemOnly].map((item, index) => event("item", item, index + 1))),
  );
  expect(subagentToolCallCount(snapshot)).toEqual({ count: 1, exact: false });
  expect(snapshot.tool).toMatchObject({ name: "read", text: "Reading source" });
});

it.each(["hidden", "suppressed"])("preserves %s item visibility", (visibility) => {
  const hidden = visibility === "hidden";
  const first = hidden
    ? event("tool", { toolCallId: "read-1", name: "read", phase: "result" }, 1)
    : event("item", activity(), 1);
  const last = activity(
    hidden
      ? { hideFromChannelProgress: true }
      : { itemId: "duplicate-item", suppressChannelProgress: true },
  );
  expect(count(live([first, event("item", last, 2)]))).toEqual({
    count: hidden ? 0 : 1,
    exact: true,
  });
});
