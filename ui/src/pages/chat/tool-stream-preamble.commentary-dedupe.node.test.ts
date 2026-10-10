import { afterEach, describe, expect, it, vi } from "vitest";
import { projectInFlightRunSnapshot } from "../../../../src/gateway/chat-inflight-snapshot.js";
import { createChatRunState } from "../../../../src/gateway/server-chat-state.js";
import { extractText } from "../../lib/chat/message-extract.ts";
import { isHiddenAssistantStreamText } from "../../lib/chat/message-visibility.ts";
import { handleChatGatewayEvent } from "./chat-gateway.ts";
import { activeHistory, createState } from "./chat-history.inflight.test-support.ts";
import { loadChatHistory } from "./chat-history.ts";
import type { ChatState } from "./chat-state-contract.ts";
import { buildChatItems } from "./chat-thread-build.ts";
import { applySessionMessagePayload } from "./session-message-apply.ts";
import { visibleAssistantStreamParts } from "./stream-reconciliation.ts";
import { TOOL_STREAM_TEST_NOW, useToolStreamFakeTimers } from "./tool-stream.test-helpers.ts";
import { handleAgentEvent } from "./tool-stream.ts";

const COMMENTARY = "I'll list the workspace files first.";
const RUN_ID = "run-1";

function renderedTexts(host: ChatState) {
  return buildChatItems({
    paneId: "commentary-dedupe",
    sessionKey: host.sessionKey,
    runId: host.chatRunId,
    messages: host.chatMessages ?? [],
    toolMessages: [],
    streamSegments: host.chatStreamSegments ?? [],
    stream: host.chatStream,
    streamStartedAt: host.chatStreamStartedAt,
    showToolCalls: true,
  }).flatMap((item) =>
    item.kind === "group"
      ? item.messages.map(({ message }) => extractText(message))
      : item.kind === "stream"
        ? [item.text.trim()]
        : [],
  );
}

function commentaryHarness() {
  useToolStreamFakeTimers();
  const gateway = createChatRunState();
  const history = activeHistory(RUN_ID);
  const host = createState(history);
  host.chatRunId = RUN_ID;
  let seq = 0;
  let messageSeq = 0;
  const deliver = () => {
    const projected = gateway.resolveBuffer(RUN_ID);
    const delta = gateway.takeBufferDelta(RUN_ID, projected.text);
    if (delta) {
      handleChatGatewayEvent(host, {
        sessionKey: "main",
        runId: RUN_ID,
        seq: ++seq,
        state: "delta",
        ...delta,
        message: { role: "assistant", content: [{ type: "text", text: projected.text }] },
      });
    }
  };
  const stream = (itemId: string | undefined, text: string, replace = false) => {
    gateway.updateBuffer(RUN_ID, { itemId, text, replace });
    deliver();
  };
  const preamble = (itemId: string, text: string, sourceId?: string) => {
    if (sourceId) {
      // The producer's assistantProjection hands this exact source to the keyed preamble.
      stream(sourceId, "", true);
    }
    handleAgentEvent(host, {
      runId: RUN_ID,
      seq: ++seq,
      stream: "item",
      ts: TOOL_STREAM_TEST_NOW + seq,
      sessionKey: "main",
      data: { kind: "preamble", itemId, progressText: text },
    });
  };
  const persist = (itemId: string, text: string) => {
    const messageId = `saved-${itemId}`;
    const durable = {
      role: "assistant",
      content: [{ type: "text", text }],
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
    (history.messages ??= []).push(durable);
    return durable;
  };
  const tool = () =>
    handleAgentEvent(host, {
      runId: RUN_ID,
      seq: ++seq,
      stream: "tool",
      ts: TOOL_STREAM_TEST_NOW + seq,
      sessionKey: "main",
      data: { phase: "start", toolCallId: "call_1", name: "list_files", args: {} },
    });
  const parts = () =>
    visibleAssistantStreamParts(host, {
      includeCurrent: true,
      isHiddenStreamText: isHiddenAssistantStreamText,
    });
  return {
    host,
    gateway,
    stream,
    preamble,
    persist,
    tool,
    parts,
    visible: () => parts().map((part) => ({ text: part.text.trim(), itemId: part.itemId })),
    reconnect: async () => {
      history.inFlightRun = projectInFlightRunSnapshot({ chatRunState: gateway, runId: RUN_ID });
      const restored = createState(history);
      await loadChatHistory(restored);
      return restored;
    },
  };
}

describe("keyed commentary after an unphased live stream", () => {
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it.each(["history-first", "delta-first", "reconnect"] as const)(
    "keeps persisted commentary once when the identified delta is %s",
    async (order) => {
      const earlier = "An earlier observation remains visible.";
      const text = "The saved commentary should appear once.";
      const later = "The next identified item remains visible.";
      const h = commentaryHarness();
      h.stream("earlier", earlier);
      if (order === "history-first") {
        h.persist("commentary-1", text);
      }
      h.stream("commentary-1", text);
      if (order !== "history-first") {
        h.persist("commentary-1", text);
      }
      h.stream("commentary-2", later);
      const displayed = order === "reconnect" ? await h.reconnect() : h.host;
      // Unsaved live text stays at the bottom of its run until it takes a saved position.
      expect(renderedTexts(displayed)).toEqual([text, `${earlier}\n\n${later}`]);
    },
  );

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
    expect(h.visible()).toEqual([{ text: COMMENTARY, itemId: undefined }]);
    h.preamble("sig-1", COMMENTARY, "source-a");
    expect(h.visible()).toEqual([{ text: COMMENTARY, itemId: "sig-1" }]);
    h.tool();
    expect(h.visible()).toEqual([{ text: COMMENTARY, itemId: "sig-1" }]);
    h.stream("source-b", "Found a match, now let me read the file");
    expect(h.visible()).toEqual([
      { text: COMMENTARY, itemId: "sig-1" },
      { text: "Found a match, now let me read the file", itemId: undefined },
    ]);
  });

  it("preserves complete source formatting in the keyed projection", () => {
    const text = "```python\nif ready:\n    run()\n```";
    const h = commentaryHarness();
    h.stream("source-a", `${text}\n\n`);
    h.preamble("item-a", text, "source-a");
    h.preamble("item-a", text);
    expect(h.visible()).toEqual([{ text, itemId: "item-a" }]);
  });

  it.each([`${COMMENTARY} More detail.`, `Before. ${COMMENTARY}`])(
    "does not retire a different complete occurrence: %s",
    (text) => {
      const h = commentaryHarness();
      h.stream("different-source", text);
      h.preamble("item-a", COMMENTARY);
      expect(h.visible()).toEqual([
        { text: COMMENTARY, itemId: "item-a" },
        { text, itemId: undefined },
      ]);
    },
  );

  it("keeps already-owned bytes retired when a pending item is shortened", () => {
    const h = commentaryHarness();
    h.stream("source-a", "Checking tests");
    h.preamble("item-a", "Checking tests now", "source-a");
    h.preamble("item-a", "Checking");
    expect(h.visible()).toEqual([{ text: "Checking", itemId: "item-a" }]);
    h.stream("source-b", "A later observation.");
    h.preamble("item-a", "Checking");
    expect(h.visible()).toEqual([
      { text: "Checking", itemId: "item-a" },
      { text: "A later observation.", itemId: undefined },
    ]);
  });

  it("completes the owned prefix when the same pending item revises its text", () => {
    const h = commentaryHarness();
    h.stream("source-a", "Checking");
    h.preamble("item-a", "Checking files.", "source-a");
    h.preamble("item-a", "Checking tests.");
    h.stream("source-a", "Checking tests.");
    h.preamble("item-a", "Checking tests.", "source-a");
    expect(h.visible()).toEqual([{ text: "Checking tests.", itemId: "item-a" }]);
  });

  it("does not acquire a later occurrence for an item that never owned the earlier stream", () => {
    const h = commentaryHarness();
    h.stream("source-b", "Different text.");
    h.preamble("item-a", COMMENTARY);
    h.stream("source-b", COMMENTARY, true);
    h.preamble("item-a", COMMENTARY);
    expect(h.visible()).toEqual([
      { text: COMMENTARY, itemId: "item-a" },
      { text: COMMENTARY, itemId: undefined },
    ]);
  });

  it("does not let a late item update consume a later identical occurrence", () => {
    const h = commentaryHarness();
    h.stream("source-a", `${COMMENTARY}\n\n`);
    h.preamble("item-a", COMMENTARY, "source-a");
    h.stream("source-b", `${COMMENTARY}\n\n`);
    h.preamble("item-a", COMMENTARY);
    expect(h.visible()).toEqual([
      { text: COMMENTARY, itemId: "item-a" },
      { text: COMMENTARY, itemId: undefined },
    ]);
    h.preamble("item-b", COMMENTARY, "source-b");
    expect(h.visible()).toEqual([
      { text: COMMENTARY, itemId: "item-a" },
      { text: COMMENTARY, itemId: "item-b" },
    ]);
  });

  it("retires a saved owner's first occurrence only, including delayed updates", () => {
    const h = commentaryHarness();
    const saved = h.persist("item-a", COMMENTARY);
    h.stream("item-a", `${COMMENTARY}\n\n`);
    h.preamble("item-a", COMMENTARY);
    expect(h.visible()).toEqual([]);
    expect(h.host.chatMessages).toEqual([saved]);
    h.stream("source-b", COMMENTARY);
    h.preamble("item-a", COMMENTARY);
    expect(h.visible()).toEqual([{ text: COMMENTARY, itemId: undefined }]);
  });

  it("transfers the rolled-over occurrence without changing its tool boundary", () => {
    const h = commentaryHarness();
    h.stream("source-a", `${COMMENTARY}\n\n`);
    h.tool();
    h.preamble("item-a", COMMENTARY, "source-a");
    expect(h.visible()).toEqual([{ text: COMMENTARY, itemId: "item-a" }]);
    h.stream("source-b", "Later text.");
    h.preamble("item-a", COMMENTARY);
    expect(h.visible()).toEqual([
      { text: COMMENTARY, itemId: "item-a" },
      { text: "Later text.", itemId: undefined },
    ]);
  });

  it("keeps leading code indentation on a later cumulative occurrence", () => {
    const code = "    execute()\n    finish()";
    const h = commentaryHarness();
    h.stream("source-a", `${COMMENTARY}\n\n`);
    h.preamble("item-a", COMMENTARY, "source-a");
    h.stream("source-b", code);
    h.preamble("item-b", code, "source-b");
    expect(h.parts().map((part) => part.text)).toEqual([COMMENTARY, code]);
  });

  it("does not reacquire an occurrence after an item is cleared", () => {
    const h = commentaryHarness();
    h.stream("source-a", `${COMMENTARY}\n\n`);
    h.preamble("item-a", COMMENTARY, "source-a");
    h.preamble("item-a", "");
    h.stream("source-b", COMMENTARY);
    h.preamble("item-a", COMMENTARY);
    expect(h.visible()).toEqual([
      { text: COMMENTARY, itemId: "item-a" },
      { text: COMMENTARY, itemId: undefined },
    ]);
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
    expect(h.visible()).toEqual([{ text: COMMENTARY, itemId: "item-a" }]);
  });

  it("completes a keyed handoff when the last chat chunk arrives between update and end", () => {
    const text =
      "Commentary formatting proof.\n\n- first file\n- second file\n\n```python\nif ready:\n    execute()\n```";
    const h = commentaryHarness();
    h.stream("source-a", text.slice(0, -4));
    h.preamble("item-a", text.slice(0, -4), "source-a");
    h.stream("source-a", text);
    h.preamble("item-a", text, "source-a");
    expect(h.visible()).toEqual([{ text, itemId: "item-a" }]);
    h.stream("source-b", "A later observation.");
    h.preamble("item-a", text);
    expect(h.visible()).toEqual([
      { text, itemId: "item-a" },
      { text: "A later observation.", itemId: undefined },
    ]);
  });
});
