import { describe, expect, it } from "vitest";
import type { AgentActivityItem } from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import type { ChatHistoryResult } from "./chat-history-snapshot.ts";
import { readSubagentActivitySnapshot, subagentToolCallCount } from "./subagents-panel-activity.ts";
import type { AgentEventPayload } from "./tool-stream-contract.ts";

function toolCall(id: string | undefined = "read-1") {
  return {
    role: "assistant",
    runId: "run-1",
    content: [
      { type: "toolCall", ...(id ? { id } : {}), name: "read", arguments: { path: "src/app.ts" } },
    ],
  };
}

function toolResult() {
  return {
    role: "toolResult",
    runId: "run-1",
    toolCallId: "read-1",
    toolName: "read",
    content: [{ type: "text", text: "export const ready = true;" }],
  };
}

function activity(extra: Partial<AgentActivityItem> = {}): AgentActivityItem {
  return {
    itemId: "item-read-1",
    toolCallId: "read-1",
    kind: "tool",
    name: "read",
    title: "Read file",
    phase: "end",
    status: "completed",
    ...extra,
  };
}

function complete(messages: unknown[], extra: Partial<ChatHistoryResult> = {}): ChatHistoryResult {
  return { messages, hasMore: false, totalMessages: messages.length, ...extra };
}

function event(stream: string, data: AgentEventPayload["data"], seq: number): AgentEventPayload {
  return { runId: "run-1", seq, ts: 1000 + seq, stream, data };
}

const count = (history: ChatHistoryResult) =>
  subagentToolCallCount(readSubagentActivitySnapshot(history));

describe("subagent panel call counts", () => {
  it.each([
    { name: "complete ordinary history", history: complete([toolCall()]), expected: 1 },
    { name: "empty complete history", history: complete([]), expected: 0 },
    {
      name: "older pages remain",
      history: complete([toolCall()], { hasMore: true, nextOffset: 1, totalMessages: 20 }),
      expected: undefined,
    },
    {
      name: "byte-limited tail",
      history: complete([toolCall()], { totalMessages: 2 }),
      expected: undefined,
    },
    {
      name: "older page without its tail",
      history: complete([toolCall()], { offset: 20 }),
      expected: undefined,
    },
    {
      name: "uncertified legacy response",
      history: { messages: [toolCall()] },
      expected: undefined,
    },
    {
      name: "native complete projection",
      history: { messages: [toolCall()], completeSnapshot: true },
      expected: 1,
    },
    { name: "unkeyed legacy call", history: complete([toolCall("")]), expected: undefined },
    {
      name: "call without a recorded run owner",
      history: complete([{ ...toolCall(), runId: undefined }]),
      expected: undefined,
    },
    {
      name: "prepared item without an invocation ID",
      history: complete([
        {
          role: "assistant",
          runId: "run-1",
          content: [],
          activity: [activity({ toolCallId: undefined })],
        },
      ]),
      expected: undefined,
    },
    { name: "unknown history", history: {}, expected: undefined },
  ])("only reports an exact total for $name", ({ history, expected }) => {
    expect(count(history)).toBe(expected);
  });

  it("counts paired transcript calls, results and replayed live items once", () => {
    expect(
      count(
        complete([toolCall(), toolResult()], {
          inFlightRun: {
            runId: "run-1",
            events: [
              event("tool", { toolCallId: "read-1", name: "read", phase: "start" }, 1),
              event("item", activity({ phase: "start", status: "running" }), 2),
              event("tool", { toolCallId: "read-1", name: "read", phase: "result" }, 3),
              event("item", activity(), 4),
            ],
          },
        }),
      ),
    ).toBe(1);
  });

  it("does not recover raw calls that an explicit empty activity projection hid", () => {
    expect(count(complete([{ ...toolCall(), activity: [] }, toolResult()]))).toBe(0);
  });

  it("keeps reused call IDs in distinct recorded runs separate while deduplicating each result", () => {
    expect(
      count(
        complete(
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
        ),
      ),
    ).toBe(2);
  });

  it.each(["promoted", "omitted"])(
    "withholds the count when an invocation ID is %s across item frames",
    (change) => {
      const known = activity({
        phase: "update",
        status: "running",
        progressText: "Reading source",
      });
      const itemOnly = activity({
        toolCallId: undefined,
        phase: "start",
        status: "running",
        progressText: "Reading source",
      });
      const frames = change === "promoted" ? [itemOnly, known] : [known, itemOnly];
      const snapshot = readSubagentActivitySnapshot(
        complete([], {
          inFlightRun: {
            runId: "run-1",
            events: frames.map((item, index) => event("item", item, index + 1)),
          },
        }),
      );
      expect(subagentToolCallCount(snapshot)).toBeUndefined();
      expect(snapshot.tool).toMatchObject({ name: "read", text: "Reading source" });
    },
  );

  it("omits hidden routine activity while retaining visible operations", () => {
    expect(
      count(
        complete([
          {
            role: "assistant",
            runId: "run-1",
            content: [],
            activity: [
              activity(),
              activity({
                itemId: "poll-item",
                toolCallId: "poll-call",
                name: "process",
                hideFromChannelProgress: true,
              }),
              activity({
                itemId: "internal-item",
                toolCallId: "internal-call",
                suppressChannelProgress: true,
              }),
            ],
          },
        ]),
      ),
    ).toBe(1);
  });

  it.each([
    {
      name: "a raw lifecycle frame follows a prepared hidden item",
      events: [
        event("item", activity({ hideFromChannelProgress: true }), 1),
        event("tool", { toolCallId: "read-1", name: "read", phase: "result" }, 2),
      ],
      expected: 0,
    },
    {
      name: "a prepared hidden item follows its raw lifecycle frame",
      events: [
        event("tool", { toolCallId: "read-1", name: "read", phase: "result" }, 1),
        event("item", activity({ hideFromChannelProgress: true }), 2),
      ],
      expected: 0,
    },
    {
      name: "a suppressed duplicate follows its visible prepared operation",
      events: [
        event("item", activity(), 1),
        event("item", activity({ itemId: "duplicate-item", suppressChannelProgress: true }), 2),
      ],
      expected: 1,
    },
  ])("preserves prepared visibility when $name", ({ events, expected }) => {
    expect(count(complete([], { inFlightRun: { runId: "run-1", events } }))).toBe(expected);
  });
});
