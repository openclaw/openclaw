import { afterEach, expect, it, vi } from "vitest";
import { createChatRunState } from "../../../../src/gateway/server-chat-state.js";
import { extractText } from "../../lib/chat/message-extract.ts";
import { isHiddenAssistantStreamText as isHiddenStreamText } from "../../lib/chat/message-visibility.ts";
import { handleChatGatewayEvent } from "./chat-gateway.ts";
import { activeHistory, createState } from "./chat-history.inflight.test-support.ts";
import { applySessionMessagePayload } from "./session-message-apply.ts";
import { visibleAssistantStreamParts } from "./stream-reconciliation.ts";
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
  const agent = (stream: "item" | "tool", data: Record<string, unknown>) =>
    handleAgentEvent(host, {
      ...envelope(),
      stream,
      ts: TOOL_STREAM_TEST_NOW + seq,
      data,
    });
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
  return { host, stream, preamble, persist, tool, expectParts };
}

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
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
