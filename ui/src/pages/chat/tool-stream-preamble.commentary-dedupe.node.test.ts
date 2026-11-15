import { afterEach, expect, it, vi } from "vitest";
import { createChatRunState } from "../../../../src/gateway/server-chat-state.js";
import { extractText } from "../../lib/chat/message-extract.ts";
import { isHiddenAssistantStreamText as isHiddenStreamText } from "../../lib/chat/message-visibility.ts";
import { extractToolCardsCached as extractToolCards } from "../../lib/chat/tool-cards.ts";
import { handleChatGatewayEvent } from "./chat-gateway.ts";
import {
  activeHistory,
  buildStateItems,
  createState,
} from "./chat-history.inflight.test-support.ts";
import { applySessionMessagePayload } from "./session-message-apply.ts";
import {
  materializeVisibleStreamState,
  visibleAssistantStreamParts,
} from "./stream-reconciliation.ts";
import { TOOL_STREAM_TEST_NOW, useToolStreamFakeTimers } from "./tool-stream.test-helpers.ts";
import { handleAgentEvent } from "./tool-stream.ts";

const COMMENTARY = "I'll list the workspace files first.";
const RUN_ID = "run-1";

const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });

function commentaryHarness() {
  useToolStreamFakeTimers();
  const gateway = createChatRunState();
  const host = createState(activeHistory(RUN_ID));
  host.chatRunId = RUN_ID;
  let seq = 0;
  let messageSeq = 0;
  const envelope = () => ({ sessionKey: "main", runId: RUN_ID, seq: ++seq });
  const agent = (
    stream: "item" | "tool",
    data: Record<string, unknown>,
    source: "live" | "history" = "live",
  ) =>
    handleAgentEvent(
      host,
      {
        ...envelope(),
        stream,
        ts: TOOL_STREAM_TEST_NOW + seq,
        data,
      },
      source,
    );
  const deliver = () => {
    const projected = gateway.resolveBuffer(RUN_ID);
    const delta = gateway.takeBufferDelta(RUN_ID, projected.text);
    if (delta) {
      handleChatGatewayEvent(host, {
        ...envelope(),
        state: "delta",
        ...delta,
        message: assistant(projected.text),
      });
    }
  };
  const stream = (itemId: string | undefined, text: string, replace = false) => {
    gateway.updateBuffer(RUN_ID, { itemId, text, replace });
    deliver();
  };
  const preamble = (itemId: string, text: string, sourceId?: string) => {
    if (sourceId) {
      stream(sourceId, "", true);
    }
    agent("item", { kind: "preamble", itemId, progressText: text });
  };
  const persist = (itemId: string, text: string) => {
    const messageId = `saved-${itemId}`;
    const durable = {
      ...assistant(text),
      __openclaw: { id: messageId, seq: ++messageSeq, runId: RUN_ID },
      openclawStreamFallback: { source: "segment", itemId },
    };
    gateway.retireBuffer(RUN_ID, [itemId]);
    applySessionMessagePayload(
      host,
      { runId: RUN_ID, messageId, messageSeq, message: durable },
      true,
      { kind: "live", activeRunId: RUN_ID },
    );
    deliver();
    return durable;
  };
  const tool = () =>
    agent("tool", { phase: "start", toolCallId: "call_1", name: "list_files", args: {} });
  const parts = () =>
    visibleAssistantStreamParts(host, { includeCurrent: true, isHiddenStreamText });
  const expectParts = (...expected: [string, string | undefined][]) =>
    expect(parts().map((part) => [part.text.trim(), part.itemId])).toEqual(expected);
  return { host, stream, preamble, persist, tool, expectParts, agent };
}

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

it.each([
  { source: "live", steered: false },
  { source: "history", steered: false },
  { source: "history", steered: true },
] as const)(
  "keeps a nested wait after $source commentary (steered=$steered)",
  ({ source, steered }) => {
    const h = commentaryHarness();
    h.host.chatMessages = [
      {
        role: "user",
        content: "Collect the results",
        timestamp: 1,
        __openclaw: { id: "collect-user", idempotencyKey: "run-1:user", seq: 1 },
      },
    ];
    h.agent(
      "item",
      {
        kind: "preamble",
        itemId: "collect-commentary",
        progressText: "Waiting for the collected results.",
      },
      source,
    );
    if (steered) {
      h.host.chatMessages.push({
        role: "user",
        content: "Keep the existing collection",
        timestamp: TOOL_STREAM_TEST_NOW + 2,
        __openclaw: {
          id: "steer-user",
          idempotencyKey: "steer:user",
          steerTargetRunId: RUN_ID,
          seq: 2,
        },
      });
    }
    const args = { title: "Collect results", code: "return await agents_wait({ids: ['child']});" };
    h.agent("tool", { phase: "start", toolCallId: "collect", name: "exec", args });
    applySessionMessagePayload(
      h.host,
      {
        runId: RUN_ID,
        messageId: "saved-collect",
        messageSeq: steered ? 3 : 2,
        message: {
          role: "assistant",
          timestamp: TOOL_STREAM_TEST_NOW - 1_000,
          content: [{ type: "toolCall", id: "collect", name: "exec", arguments: args }],
          __openclaw: { id: "saved-collect", seq: steered ? 3 : 2, runId: RUN_ID },
        },
      },
      true,
      { kind: "live", activeRunId: RUN_ID },
    );
    h.agent("tool", {
      phase: "start",
      toolCallId: "wait",
      parentToolCallId: "collect",
      name: "agents_wait",
      args: { ids: ["child"] },
    });
    vi.advanceTimersByTime(100);
    const order = buildStateItems(h.host).flatMap((item) =>
      item.kind === "group"
        ? item.messages.flatMap(({ message }) => {
            const cards = extractToolCards(message);
            return cards.length ? cards.map((card) => card.callId) : [item.role];
          })
        : [item.kind],
    );
    expect(order).toEqual(
      steered
        ? ["user", "stream", "user", "collect", "wait"]
        : ["user", "stream", "collect", "wait"],
    );
    const materialized = materializeVisibleStreamState(h.host.chatMessages, h.host, {
      persistCommentary: true,
      isHiddenAssistantMessage: () => false,
      isHiddenStreamText,
    });
    expect(
      materialized.flatMap((message) => {
        const cards = extractToolCards(message);
        return cards.length ? cards.map((card) => card.callId) : [extractText(message)];
      }),
    ).toEqual([
      "Collect the results",
      "Waiting for the collected results.",
      ...(steered ? ["Keep the existing collection"] : []),
      "collect",
    ]);
  },
);

it("does not anchor new commentary to a reused call ID from an older run", () => {
  const h = commentaryHarness();
  h.host.chatMessages = [
    { role: "user", content: "Earlier request", timestamp: 1 },
    {
      role: "assistant",
      timestamp: 2,
      content: [{ type: "toolCall", id: "collect", name: "exec", arguments: {} }],
      __openclaw: { id: "old-collect", seq: 1, runId: "old-run" },
    },
    { role: "user", content: "Collect the results", timestamp: 3 },
  ];
  h.preamble("collect-commentary", "Waiting for the collected results.");
  h.agent("tool", { phase: "start", toolCallId: "collect", name: "exec", args: {} });
  vi.advanceTimersByTime(100);
  const rows = buildStateItems(h.host).flatMap((item) =>
    item.kind === "group" ? [item.role] : [item.kind],
  );
  expect(rows.indexOf("stream")).toBeGreaterThan(rows.lastIndexOf("user"));
});

it("does not let stale item identity prune a newer unscoped append", () => {
  const h = commentaryHarness();
  h.stream("commentary-1", COMMENTARY);
  h.stream(undefined, `${COMMENTARY}\n\nNewer response`);
  h.persist("commentary-1", COMMENTARY);
  expect(h.host.chatMessages.map(extractText)).toEqual([COMMENTARY]);
  expect(h.host.chatStream).toContain("Newer response");
});

it("renders tool-boundary commentary once across item and chat stream", () => {
  const h = commentaryHarness();
  h.stream("source-a", `${COMMENTARY}\n\n`);
  h.expectParts([COMMENTARY, undefined]);
  h.preamble("sig-1", COMMENTARY, "source-a");
  h.expectParts([COMMENTARY, "sig-1"]);
  h.tool();
  h.expectParts([COMMENTARY, "sig-1"]);
  h.stream("source-b", "Found a match, now let me read the file");
  h.expectParts([COMMENTARY, "sig-1"], ["Found a match, now let me read the file", undefined]);
});

it.each([false, true])("does not reacquire a later occurrence (cleared=%s)", (cleared) => {
  const h = commentaryHarness();
  h.stream("source-a", `${COMMENTARY}\n\n`);
  h.preamble("item-a", COMMENTARY, "source-a");
  if (cleared) {
    h.preamble("item-a", "");
  }
  h.stream("source-b", cleared ? COMMENTARY : `${COMMENTARY}\n\n`);
  h.preamble("item-a", COMMENTARY);
  h.expectParts([COMMENTARY, "item-a"], [COMMENTARY, undefined]);
  if (!cleared) {
    h.preamble("item-b", COMMENTARY, "source-b");
    h.expectParts([COMMENTARY, "item-a"], [COMMENTARY, "item-b"]);
  }
});

it("retires a saved owner's first occurrence only, including delayed updates", () => {
  const h = commentaryHarness();
  const saved = h.persist("item-a", COMMENTARY);
  h.stream("item-a", `${COMMENTARY}\n\n`);
  h.preamble("item-a", COMMENTARY);
  h.expectParts();
  expect(h.host.chatMessages).toEqual([saved]);
  h.stream("source-b", COMMENTARY);
  h.preamble("item-a", COMMENTARY);
  h.expectParts([COMMENTARY, undefined]);
});

it("keeps earlier different cumulative text visible when a later occurrence becomes keyed", () => {
  const earlier = "The first observation stays visible.";
  const h = commentaryHarness();
  h.stream("earlier", `${earlier}\n\n`);
  const saved = h.persist("earlier", earlier);
  h.tool();
  h.stream("source-a", `${COMMENTARY}\n\n`);
  h.preamble("item-a", COMMENTARY, "source-a");
  expect(h.host.chatMessages).toEqual([saved]);
  h.expectParts([COMMENTARY, "item-a"]);
});

it("completes a keyed handoff when the last chat chunk arrives between update and end", () => {
  const text =
    "Commentary formatting proof.\n\n- first file\n- second file\n\n```python\nif ready:\n    execute()\n```";
  const h = commentaryHarness();
  h.stream("source-a", text.slice(0, -4));
  h.preamble("item-a", text.slice(0, -4), "source-a");
  h.stream("source-a", text);
  h.preamble("item-a", text, "source-a");
  h.expectParts([text, "item-a"]);
  h.stream("source-b", "A later observation.");
  h.preamble("item-a", text);
  h.expectParts([text, "item-a"], ["A later observation.", undefined]);
});
