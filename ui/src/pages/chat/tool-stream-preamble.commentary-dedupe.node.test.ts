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
  renderedText,
} from "./chat-history.inflight.test-support.ts";
import { loadChatHistory } from "./chat-history.ts";
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
    source?: "live" | "history",
  ) =>
    handleAgentEvent(host, { ...envelope(), stream, ts: TOOL_STREAM_TEST_NOW + seq, data }, source);
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
  const save = (id: string, message: object, order = ++messageSeq) => {
    const durable = { ...message, __openclaw: { id, seq: order, runId: RUN_ID } };
    const payload = { runId: RUN_ID, messageId: id, messageSeq: order, message: durable };
    applySessionMessagePayload(host, payload, true, { kind: "live", activeRunId: RUN_ID });
    return durable;
  };
  const persist = (itemId: string, text: string) => {
    gateway.retireBuffer(RUN_ID, [itemId]);
    const fallback = { source: "segment", itemId };
    const durable = save(`saved-${itemId}`, {
      ...assistant(text),
      openclawStreamFallback: fallback,
    });
    deliver();
    return durable;
  };
  const tool = () =>
    agent("tool", { phase: "start", toolCallId: "call_1", name: "list_files", args: {} });
  const parts = () =>
    visibleAssistantStreamParts(host, { includeCurrent: true, isHiddenStreamText });
  const expectParts = (...expected: [string, string | undefined][]) =>
    expect(parts().map((part) => [part.text.trim(), part.itemId])).toEqual(expected);
  return { host, stream, preamble, persist, tool, expectParts, agent, save };
}

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

const callIdsOrText = (message: unknown, fallback: string) => {
  const cards = extractToolCards(message);
  return cards.length ? cards.map((card) => card.callId) : [fallback];
};

// Live and replayed starts carry different send anchors; the saved call is older than the
// commentary, and nested work must not claim it. Commentary stays before a steer, and an
// older run's reused call ID is not an anchor.
it.each(["live", "history"] as const)("binds %s commentary to the next root call", (source) => {
  const h = commentaryHarness();
  const steered = source === "history";
  const user = (content: string, seq: number, idempotencyKey: string, steer?: string) => ({
    role: "user",
    content,
    timestamp: steer ? TOOL_STREAM_TEST_NOW + seq : seq,
    __openclaw: { id: `user-${seq}`, idempotencyKey, steerTargetRunId: steer, seq },
  });
  const args = { code: "return await agents_wait({ids: ['child']});" };
  const call = { type: "toolCall", id: "collect", name: "exec", arguments: args };
  h.host.chatMessages = [
    { role: "assistant", timestamp: 0, content: [call], __openclaw: { runId: "old-run" } },
    user("Collect the results", 1, `${RUN_ID}:user`),
  ];
  const progressText = "Waiting for the collected results.";
  h.agent("item", { kind: "preamble", itemId: "commentary", progressText }, source);
  if (steered) {
    h.host.chatMessages.push(user("Keep the existing collection", 2, "steer:user", RUN_ID));
  }
  h.agent("tool", { phase: "start", toolCallId: "collect", name: "exec", args });
  const savedAt = TOOL_STREAM_TEST_NOW - 1_000;
  h.save("saved-collect", { role: "assistant", timestamp: savedAt, content: [call] }, 3);
  const wait = { toolCallId: "wait", parentToolCallId: "collect", name: "agents_wait" };
  h.agent("tool", { ...wait, phase: "start" });
  vi.advanceTimersByTime(100);
  expect(
    buildStateItems(h.host).flatMap((item) =>
      item.kind === "group"
        ? item.messages.flatMap(({ message }) => callIdsOrText(message, item.role))
        : [item.kind],
    ),
  ).toEqual(["collect", "user", "stream", ...(steered ? ["user"] : []), "collect", "wait"]);
  const materialized = materializeVisibleStreamState(h.host.chatMessages, h.host, {
    persistCommentary: true,
    isHiddenAssistantMessage: () => false,
    isHiddenStreamText,
  });
  expect(materialized.flatMap((m) => callIdsOrText(m, extractText(m) ?? ""))).toEqual([
    "collect",
    "Collect the results",
    progressText,
    ...(steered ? ["Keep the existing collection"] : []),
    "collect",
  ]);
});

it("orders completed native text before each root call without rolling over the reply", () => {
  const h = commentaryHarness();
  const order = () =>
    buildStateItems(h.host).flatMap((item) =>
      item.kind === "group"
        ? item.messages.flatMap(({ message }) => callIdsOrText(message, extractText(message) ?? ""))
        : item.kind === "stream" && item.text.trim()
          ? [item.text.trim()]
          : [],
    );
  const call = (id: string, text: string) => {
    h.stream(undefined, text);
    h.agent("tool", {
      name: "read",
      phase: "start",
      toolCallId: id,
      textLengthBeforeTool: text.length,
    });
    vi.advanceTimersByTime(100);
  };
  call("amber", "Amber.");
  expect(order()).toEqual(["Amber.", "amber"]);
  const cumulative = "Amber.\n\nCobalt.";
  call("cobalt", cumulative);
  expect(order()).toEqual(["Amber.", "amber", "Cobalt.", "cobalt"]);
  h.stream(undefined, cumulative + "\n\nAmber. New result.");
  expect(order()).toEqual(["Amber.", "amber", "Cobalt.", "cobalt", "Amber. New result."]);
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

it("keeps only keyed commentary and hidden cumulative prefixes through history and later deltas", async () => {
  const h = commentaryHarness();
  const visibleText = () => renderedText(h.host).filter((text) => typeof text === "string");
  vi.stubGlobal("window", globalThis);
  try {
    h.agent("item", { kind: "preamble", progressText: COMMENTARY });
    expect(h.host.chatStreamSegments).toMatchObject([
      { itemId: expect.any(String), text: COMMENTARY },
    ]);
    h.tool();
    vi.advanceTimersByTime(100);
    expect(h.host.chatToolMessages).toHaveLength(1);
    const commentaryId = h.host.chatStreamSegments[0]!.itemId!;
    const commentary = h.persist(commentaryId, COMMENTARY);
    h.stream("answer-source", "Before steer.");
    const prefix = {
      ...assistant("Before steer."),
      __openclaw: { id: "saved-prefix", seq: 2, runId: RUN_ID },
    };
    const history = {
      messages: [commentary, prefix],
      sessionInfo: activeHistory(RUN_ID).sessionInfo,
    };
    vi.spyOn(h.host.client!, "request").mockResolvedValue(history);
    await loadChatHistory(h.host);
    expect(h.host.chatRunId).toBe(RUN_ID);
    expect(h.host.chatStreamSegments).toEqual([
      { text: "Before steer.", ts: expect.any(Number), runId: RUN_ID, persisted: true },
    ]);
    h.stream("answer-source", "Before steer. After steer.");
    h.expectParts(["After steer.", undefined]);
    history.messages.push({
      ...assistant("After steer."),
      __openclaw: { id: "saved-followup", seq: 3, runId: RUN_ID },
    });
    await loadChatHistory(h.host);
    expect(h.host.chatStreamSegments).toMatchObject([
      { text: "Before steer.", persisted: true },
      { text: "Before steer. After steer.", persisted: true },
    ]);
    h.stream("answer-source", "Before steer. After steer. Continued.");
    h.expectParts(["Continued.", undefined]);
    expect(visibleText()).toEqual([COMMENTARY, "Before steer.", "After steer.", "Continued."]);
    handleChatGatewayEvent(h.host, { sessionKey: "main", runId: RUN_ID, state: "aborted" });
    expect(h.host.chatStreamSegments).toEqual([]);
    expect(h.host.chatRunId).toBeNull();
    expect(visibleText()).toEqual([COMMENTARY, "Before steer.", "After steer.", "Continued."]);
  } finally {
    vi.unstubAllGlobals();
  }
});
