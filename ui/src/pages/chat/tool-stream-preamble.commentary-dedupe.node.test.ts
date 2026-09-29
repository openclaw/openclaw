import { afterEach, describe, expect, it, vi } from "vitest";
import { extractText } from "../../lib/chat/message-extract.ts";
import { isHiddenAssistantStreamText } from "../../lib/chat/message-visibility.ts";
import { handleChatGatewayEvent } from "./chat-gateway.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import type { ChatState } from "./chat-state-contract.ts";
import { buildChatItems } from "./chat-thread-build.ts";
import { applySessionMessagePayload } from "./session-message-apply.ts";
import { rolloverChatStream } from "./stream-causal-boundary.ts";
import { visibleAssistantStreamParts } from "./stream-reconciliation.ts";
import { reconcilePersistedAssistantStream } from "./stream-segment-pruning.ts";
import {
  createHost,
  TOOL_STREAM_TEST_NOW,
  useToolStreamFakeTimers,
} from "./tool-stream.test-helpers.ts";
import { handleAgentEvent } from "./tool-stream.ts";

const COMMENTARY = "I'll list the workspace files first.";

function createChatState(
  overrides: Parameters<typeof makeChatHost>[0] = {},
): ReturnType<typeof makeChatHost> {
  return makeChatHost({ chatRunId: "run-1", sessionKey: "main", ...overrides });
}

function visibleParts(host: ReturnType<typeof createHost>) {
  return visibleAssistantStreamParts(host, {
    includeCurrent: true,
    isHiddenStreamText: isHiddenAssistantStreamText,
  }).map((part) => ({ text: part.text.trim(), itemId: part.itemId }));
}

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

function preamble(
  host: Parameters<typeof handleAgentEvent>[0],
  itemId: string,
  text: string,
  seq: number,
) {
  handleAgentEvent(host, {
    runId: "run-1",
    seq,
    stream: "item",
    ts: TOOL_STREAM_TEST_NOW + seq,
    sessionKey: "main",
    data: { kind: "preamble", itemId, progressText: text },
  });
}

describe("keyed commentary after an unphased live stream", () => {
  afterEach(() => vi.useRealTimers());
  const persistCommentary = (host: ChatState, text: string, itemId = "commentary-1") =>
    applySessionMessagePayload(
      host,
      {
        runId: "run-1",
        messageId: `saved-${itemId}`,
        messageSeq: 1,
        message: {
          role: "assistant",
          content: [{ type: "text", text }],
          __openclaw: { id: `saved-${itemId}`, seq: 1, runId: "run-1" },
          openclawStreamFallback: { source: "segment", itemId },
        },
      },
      true,
      { kind: "live", activeRunId: "run-1" },
    );

  it("keeps persisted commentary once when its cumulative delta arrives late", () => {
    const earlier = "An earlier observation remains visible.";
    const text = "The saved commentary should appear once.";
    const host = createChatState({ chatStream: earlier });

    persistCommentary(host, text);

    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 2,
      state: "delta",
      itemId: "commentary-1",
      itemStartOffset: `${earlier}\n\n`.length,
      message: { role: "assistant", content: [{ type: "text", text: `${earlier}\n\n${text}` }] },
    });

    expect(renderedTexts(host)).toEqual([earlier, text]);
  });

  it("keeps persisted commentary once when its keyed delta arrives first", () => {
    const earlier = "An earlier observation remains visible.";
    const text = "The early keyed commentary should appear once.";
    const host = createChatState();

    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 2,
      state: "delta",
      itemId: "commentary-1",
      itemStartOffset: `${earlier}\n\n`.length,
      message: { role: "assistant", content: [{ type: "text", text: `${earlier}\n\n${text}` }] },
    });
    persistCommentary(host, text);

    expect(renderedTexts(host)).toEqual([earlier, text]);
  });

  it("keeps commentary once after the Gateway suppresses a silent predecessor", () => {
    const text = "Visible commentary after a silent item.";
    const host = createChatState();

    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 2,
      state: "delta",
      itemId: "commentary-1",
      itemStartOffset: 0,
      message: { role: "assistant", content: [{ type: "text", text }] },
    });
    persistCommentary(host, text);

    expect(renderedTexts(host)).toEqual([text]);
  });

  it("keeps delta-first commentary once after a tool-boundary rollover", () => {
    const earlier = "Earlier output survives rollover.";
    const text = "The rolled commentary should appear once.";
    const host = createChatState();

    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 2,
      state: "delta",
      itemId: "commentary-1",
      itemStartOffset: `${earlier}\n\n`.length,
      message: { role: "assistant", content: [{ type: "text", text: `${earlier}\n\n${text}` }] },
    });
    rolloverChatStream(host, { runId: "run-1", toolCallId: "call-1" });
    persistCommentary(host, text);

    expect(renderedTexts(host)).toEqual([earlier, text]);
  });

  it("keeps a later identical delta after persistence replaced the live item", () => {
    const text = "The saved commentary should appear twice.";
    const host = createChatState();
    preamble(host, "commentary-1", text, 1);
    persistCommentary(host, text);

    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 2,
      state: "delta",
      message: { role: "assistant", content: [{ type: "text", text }] },
    });

    expect(renderedTexts(host).filter((entry) => entry === text)).toHaveLength(2);
  });

  it("retires a persistence-first receipt when an older Gateway omits item metadata", () => {
    const text = "The saved commentary should appear once without item metadata.";
    const host = createChatState();

    persistCommentary(host, text);
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 2,
      state: "delta",
      message: { role: "assistant", content: [{ type: "text", text }] },
    });

    expect(renderedTexts(host)).toEqual([text]);
  });

  it("does not let a pending receipt consume another item's identical delta", () => {
    const text = "Two items can say the same thing.";
    const host = createChatState();

    persistCommentary(host, text);
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 2,
      state: "delta",
      itemId: "commentary-2",
      itemStartOffset: 0,
      message: { role: "assistant", content: [{ type: "text", text }] },
    });

    expect(renderedTexts(host).filter((entry) => entry === text)).toHaveLength(2);
  });

  it("does not let a metadata-free paced frame consume another item's receipt", () => {
    const text = "Two paced items can say the same thing.";
    const host = createChatState();

    persistCommentary(host, text, "commentary-2");
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 1,
      state: "delta",
      itemId: "commentary-1",
      itemStartOffset: 0,
      message: { role: "assistant", content: [{ type: "text", text }] },
    });
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 2,
      state: "delta",
      message: { role: "assistant", content: [{ type: "text", text }] },
    });

    expect(renderedTexts(host).filter((entry) => entry === text)).toHaveLength(2);
  });

  it("retires persisted commentary from the first received delta for a later item", () => {
    const first = "The first commentary persisted before its delta arrived.";
    const second = "The next commentary remains live.";
    const host = createChatState();

    persistCommentary(host, first);
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 2,
      state: "delta",
      itemId: "commentary-2",
      itemStartOffset: `${first}\n\n`.length,
      message: { role: "assistant", content: [{ type: "text", text: `${first}\n\n${second}` }] },
    });

    expect(renderedTexts(host)).toEqual([first, second]);
  });

  it("retires multiple persistence-first receipts from one later prefix", () => {
    const first = "The first commentary persisted early.";
    const second = "The second commentary persisted early.";
    const current = "The current commentary remains live.";
    const prefix = `${first}\n\n${second}\n\n`;
    const host = createChatState();

    persistCommentary(host, first, "commentary-1");
    persistCommentary(host, second, "commentary-2");
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 3,
      state: "delta",
      itemId: "commentary-3",
      itemStartOffset: prefix.length,
      message: { role: "assistant", content: [{ type: "text", text: `${prefix}${current}` }] },
    });

    expect(renderedTexts(host)).toEqual([first, second, current]);
  });

  it("leaves an unkeyed preceding occurrence pending for a later persisted item", () => {
    const repeated = "The same commentary text.";
    const current = "The current commentary remains live.";
    const host = createChatState();

    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 2,
      state: "delta",
      itemId: "commentary-2",
      itemStartOffset: `${repeated}\n\n`.length,
      message: {
        role: "assistant",
        content: [{ type: "text", text: `${repeated}\n\n${current}` }],
      },
    });
    persistCommentary(host, repeated, "commentary-3");

    expect(renderedTexts(host)).toEqual([`${repeated}\n\n${current}`, repeated]);
  });

  it("does not retire a persisted suffix inside another preceding item", () => {
    const preceding = "foobar";
    const persisted = "bar";
    const current = "The current commentary remains live.";
    const host = createChatState();

    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 2,
      state: "delta",
      itemId: "commentary-2",
      itemStartOffset: `${preceding}\n\n`.length,
      message: {
        role: "assistant",
        content: [{ type: "text", text: `${preceding}\n\n${current}` }],
      },
    });
    persistCommentary(host, persisted);

    expect(renderedTexts(host)).toEqual([`${preceding}\n\n${current}`, persisted]);
  });

  it("does not combine separate preceding items into one persisted item", () => {
    const first = "One";
    const second = "Two";
    const current = "The current commentary remains live.";
    const prefix = `${first}\n\n${second}\n\n`;
    const host = createChatState();

    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 2,
      state: "delta",
      itemId: "commentary-3",
      itemStartOffset: prefix.length,
      message: { role: "assistant", content: [{ type: "text", text: `${prefix}${current}` }] },
    });
    persistCommentary(host, `${first} ${second}`, "commentary-2");

    expect(renderedTexts(host)).toEqual([`${prefix}${current}`.trim(), `${first} ${second}`]);
  });

  it("retires a preceding commentary item containing a paragraph break", () => {
    const first = "First paragraph.\n\nSecond paragraph.";
    const second = "The next commentary remains live.";
    const host = createChatState();

    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 1,
      state: "delta",
      itemId: "commentary-1",
      itemStartOffset: 0,
      message: { role: "assistant", content: [{ type: "text", text: first }] },
    });
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 2,
      state: "delta",
      itemId: "commentary-2",
      itemStartOffset: `${first}\n\n`.length,
      message: { role: "assistant", content: [{ type: "text", text: `${first}\n\n${second}` }] },
    });
    persistCommentary(host, first);

    expect(renderedTexts(host)).toEqual([first, second]);
  });

  it("leaves rolled unkeyed commentary pending without producer identity", () => {
    const first = "The first commentary persists after rollover.";
    const second = "The next commentary remains live.";
    const host = createChatState();

    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 2,
      state: "delta",
      itemId: "commentary-2",
      itemStartOffset: `${first}\n\n`.length,
      message: { role: "assistant", content: [{ type: "text", text: `${first}\n\n${second}` }] },
    });
    rolloverChatStream(host, { runId: "run-1", toolCallId: "call-1" });
    persistCommentary(host, first);

    expect(renderedTexts(host)).toEqual([first, second, first]);
  });

  it("leaves multiple rolled unkeyed items pending without producer identity", () => {
    const first = "The first commentary persists after rollover.";
    const second = "The middle commentary remains live.";
    const third = "The current commentary remains live.";
    const prefix = `${first}\n\n${second}\n\n`;
    const host = createChatState();

    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 2,
      state: "delta",
      itemId: "commentary-3",
      itemStartOffset: prefix.length,
      message: { role: "assistant", content: [{ type: "text", text: `${prefix}${third}` }] },
    });
    rolloverChatStream(host, { runId: "run-1", toolCallId: "call-1" });
    persistCommentary(host, first);

    expect(renderedTexts(host)).toEqual([`${first}\n\n${second}`, third, first]);
  });

  it("keeps an identical rolled item when later persistence precedes its delta", () => {
    const text = "Two commentary items can say the same thing.";
    const host = createChatState({ chatStream: text, chatStreamStartedAt: 1 });

    rolloverChatStream(host, { runId: "run-1", toolCallId: "call-1" });
    persistCommentary(host, text);

    expect(renderedTexts(host).filter((entry) => entry === text)).toHaveLength(2);
  });

  it("retires an earlier item after the next item starts", () => {
    const first = "The first commentary is persisted late.";
    const second = "The next commentary remains live.";
    const host = createChatState();

    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 1,
      state: "delta",
      itemId: "commentary-1",
      itemStartOffset: 0,
      message: { role: "assistant", content: [{ type: "text", text: first }] },
    });
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 2,
      state: "delta",
      itemId: "commentary-2",
      itemStartOffset: `${first}\n\n`.length,
      message: { role: "assistant", content: [{ type: "text", text: `${first}\n\n${second}` }] },
    });
    persistCommentary(host, first);

    expect(renderedTexts(host)).toEqual([first, second]);
  });

  it("rebases an earlier item when a replacement frame retires its prefix", () => {
    const retired = "Retired prefix. ";
    const first = "The first commentary is partly retained.";
    const retained = "is partly retained.";
    const second = "The next commentary remains live.";
    const host = createChatState();

    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 1,
      state: "delta",
      itemId: "commentary-1",
      itemStartOffset: retired.length,
      message: { role: "assistant", content: [{ type: "text", text: `${retired}${first}` }] },
    });
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 2,
      state: "delta",
      itemId: "commentary-2",
      itemStartOffset: `${retained}\n\n`.length,
      replace: true,
      message: {
        role: "assistant",
        content: [{ type: "text", text: `${retained}\n\n${second}` }],
      },
    });
    persistCommentary(host, first);

    expect(renderedTexts(host)).toEqual([first, second]);
  });

  it("does not rebase a corrected item to an interior substring", () => {
    const host = createChatState();

    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 1,
      state: "delta",
      itemId: "commentary-1",
      itemStartOffset: 0,
      message: { role: "assistant", content: [{ type: "text", text: "bar" }] },
    });
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 2,
      state: "delta",
      replace: true,
      itemId: "commentary-2",
      itemStartOffset: "foobar\n\n".length,
      message: { role: "assistant", content: [{ type: "text", text: "foobar\n\nNext" }] },
    });
    persistCommentary(host, "foobar", "commentary-1");

    expect(renderedTexts(host)).toEqual(["foobar", "Next"]);
  });

  it("drops a superseded item when its replacement prefix cannot be aligned", () => {
    const host = createChatState();

    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 1,
      state: "delta",
      itemId: "commentary-1",
      itemStartOffset: 0,
      message: { role: "assistant", content: [{ type: "text", text: "Draft" }] },
    });
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 2,
      state: "delta",
      itemId: "commentary-2",
      itemStartOffset: "Final\n\n".length,
      replace: true,
      message: { role: "assistant", content: [{ type: "text", text: "Final\n\nNext" }] },
    });

    expect(renderedTexts(host)).toEqual(["Final", "Next"]);
  });

  it("retains item ownership across paced frames without item metadata", () => {
    const first = "The first paced commentary.";
    const second = "The second paced commentary.";
    const host = createChatState();

    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 1,
      state: "delta",
      itemId: "commentary-1",
      itemStartOffset: 0,
      message: { role: "assistant", content: [{ type: "text", text: first }] },
    });
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 2,
      state: "delta",
      message: { role: "assistant", content: [{ type: "text", text: first }] },
    });
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 3,
      state: "delta",
      itemId: "commentary-2",
      itemStartOffset: `${first}\n\n`.length,
      message: { role: "assistant", content: [{ type: "text", text: `${first}\n\n${second}` }] },
    });

    expect(visibleParts(host)).toEqual([
      { text: first, itemId: "commentary-1" },
      { text: second, itemId: undefined },
    ]);
  });

  it("keeps a repeated partial item anchored at its producer boundary", () => {
    const completed = "AxxA";
    const second = "The next commentary remains live.";
    const host = createChatState();

    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 1,
      state: "delta",
      itemId: "commentary-1",
      itemStartOffset: 0,
      message: { role: "assistant", content: [{ type: "text", text: "A" }] },
    });
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 2,
      state: "delta",
      itemId: "commentary-2",
      itemStartOffset: `${completed}\n\n`.length,
      message: {
        role: "assistant",
        content: [{ type: "text", text: `${completed}\n\n${second}` }],
      },
    });
    persistCommentary(host, completed);

    expect(renderedTexts(host)).toEqual([completed, second]);
  });

  it("rebases a repeated item to the occurrence nearest the next boundary", () => {
    const repeated = "Repeated commentary.";
    const middle = "Middle commentary.";
    const current = "Current commentary.";
    const retired = "Retired prefix.\n\n";
    const retainedPrefix = `${repeated}\n\n${middle}\n\n${repeated}\n\n`;
    const previousStream = `${retired}${retainedPrefix.trimEnd()}`;
    const host = createChatState({
      chatStream: previousStream,
      chatStreamItemId: "commentary-2",
      chatStreamItemStartOffset: previousStream.lastIndexOf(repeated),
    });

    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 2,
      state: "delta",
      replace: true,
      itemId: "commentary-3",
      itemStartOffset: retainedPrefix.length,
      message: {
        role: "assistant",
        content: [{ type: "text", text: `${retainedPrefix}${current}` }],
      },
    });
    persistCommentary(host, repeated, "commentary-2");

    expect(renderedTexts(host)).toEqual([`${repeated}\n\n${middle}`, repeated, current]);
  });

  it("does not let a third item claim an earlier keyed item with identical text", () => {
    const repeated = "The repeated commentary.";
    const middle = "The middle commentary.";
    const host = createChatState();

    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 1,
      state: "delta",
      itemId: "commentary-1",
      itemStartOffset: 0,
      message: { role: "assistant", content: [{ type: "text", text: repeated }] },
    });
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 2,
      state: "delta",
      itemId: "commentary-2",
      itemStartOffset: `${repeated}\n\n`.length,
      message: { role: "assistant", content: [{ type: "text", text: `${repeated}\n\n${middle}` }] },
    });
    persistCommentary(host, repeated, "commentary-3");
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 3,
      state: "delta",
      itemId: "commentary-3",
      itemStartOffset: `${repeated}\n\n${middle}\n\n`.length,
      message: {
        role: "assistant",
        content: [{ type: "text", text: `${repeated}\n\n${middle}\n\n${repeated}` }],
      },
    });

    expect(renderedTexts(host)).toEqual([repeated, middle, repeated]);
  });

  it("leaves multiple unkeyed preceding items pending without producer identity", () => {
    const first = "The first commentary persists late.";
    const second = "The second commentary stays live.";
    const third = "The current commentary stays live.";
    const prefix = `${first}\n\n${second}\n\n`;
    const host = createChatState();

    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 1,
      state: "delta",
      itemId: "commentary-3",
      itemStartOffset: prefix.length,
      message: { role: "assistant", content: [{ type: "text", text: `${prefix}${third}` }] },
    });
    persistCommentary(host, first);

    expect(renderedTexts(host)).toEqual([`${prefix}${third}`.trim(), first]);
  });

  it("leaves repeated prefix text pending without producer identity", () => {
    const repeated = "The repeated commentary.";
    const middle = "The middle commentary.";
    const current = "The current commentary.";
    const prefix = `${repeated}\n\n${middle}\n\n${repeated}\n\n`;
    const host = createChatState();

    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 1,
      state: "delta",
      itemId: "commentary-3",
      itemStartOffset: prefix.length,
      message: { role: "assistant", content: [{ type: "text", text: `${prefix}${current}` }] },
    });
    persistCommentary(host, repeated, "commentary-2");

    expect(renderedTexts(host)).toEqual([`${prefix}${current}`.trim(), repeated]);
  });

  it("leaves a persistence-first receipt pending across repeated prefix text", () => {
    const repeated = "The repeated commentary.";
    const middle = "The middle commentary.";
    const current = "The current commentary.";
    const prefix = `${repeated}\n\n${middle}\n\n${repeated}\n\n`;
    const host = createChatState();

    persistCommentary(host, repeated, "commentary-2");
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 1,
      state: "delta",
      itemId: "commentary-3",
      itemStartOffset: prefix.length,
      message: { role: "assistant", content: [{ type: "text", text: `${prefix}${current}` }] },
    });

    expect(renderedTexts(host)).toEqual([repeated, `${prefix}${current}`.trim()]);
  });

  it("does not reuse an identical rollover baseline from another run", () => {
    const prefix = "The current run prefix.\n\n";
    const current = "The current run item.";
    const text = `${prefix}${current}`;
    const host = createChatState({
      chatRunId: "run-2",
      chatStream: text,
      chatStreamItemId: "commentary-2",
      chatStreamItemStartOffset: prefix.length,
      chatStreamSegments: [{ text, ts: 1, runId: "run-1", persisted: true }],
    });

    rolloverChatStream(host, { runId: "run-2", toolCallId: "call-2" });

    expect(host.chatStreamSegments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ runId: "run-2", text: prefix }),
        expect.objectContaining({ runId: "run-2", itemId: "commentary-2", text: current }),
      ]),
    );
  });

  it("does not insert a rollover at another run's pending receipt", () => {
    const host = createChatState({
      chatRunId: "run-2",
      chatStream: "Run two output.",
      chatStreamItemId: "commentary-2",
      chatStreamItemStartOffset: 0,
      chatStreamSegments: [
        {
          text: "",
          ts: 1,
          runId: "run-1",
          persisted: true,
          retiredItemId: "commentary-1",
          pendingCommentary: {
            text: "Run one pending commentary.",
            prefixLength: 0,
          },
        },
        { text: "Run two output.", ts: 2, runId: "run-2" },
      ],
    });

    rolloverChatStream(host, { runId: "run-2", toolCallId: "call-2" });

    expect(host.chatStreamSegments?.map((segment) => segment.runId)).toEqual([
      "run-1",
      "run-2",
      "run-2",
    ]);
    expect(host.chatStreamSegments?.at(-1)).toEqual(
      expect.objectContaining({ itemId: "commentary-2", toolCallId: "call-2" }),
    );
  });

  it("keeps the visible prefix when rolling over a pending commentary receipt", () => {
    const earlier = "Earlier output remains visible.";
    const pending = "Persisted commentary arrives before its delta.";
    const partial = "Persisted commentary";
    const host = createChatState({ chatStream: earlier });

    persistCommentary(host, pending);
    handleChatGatewayEvent(host, {
      sessionKey: "main",
      runId: "run-1",
      seq: 2,
      state: "delta",
      itemId: "commentary-1",
      itemStartOffset: `${earlier}\n\n`.length,
      message: { role: "assistant", content: [{ type: "text", text: `${earlier}\n\n${partial}` }] },
    });
    rolloverChatStream(host, { runId: "run-1", toolCallId: "call-1" });

    expect(renderedTexts(host)).toEqual([earlier, pending]);
  });

  it("renders tool-boundary commentary once across item and chat stream", () => {
    useToolStreamFakeTimers();
    const host = createHost({ chatRunId: "run-1" });
    // openai-completions/anthropic stream the text unphased first (chat delta).
    host.chatStream = `${COMMENTARY}\n\n`;
    host.chatStreamStartedAt = TOOL_STREAM_TEST_NOW - 50;
    expect(visibleParts(host)).toEqual([{ text: COMMENTARY, itemId: undefined }]);

    // The phase tagger then keys the same text as commentary at the tool boundary.
    handleAgentEvent(host, {
      runId: "run-1",
      seq: 2,
      stream: "item",
      ts: TOOL_STREAM_TEST_NOW,
      sessionKey: "main",
      data: { kind: "preamble", itemId: "sig-1", progressText: COMMENTARY },
    });
    expect(visibleParts(host)).toEqual([{ text: COMMENTARY, itemId: "sig-1" }]);

    // Tool start rolls the chat stream into an indexed segment; it must stay retired.
    handleAgentEvent(host, {
      runId: "run-1",
      seq: 3,
      stream: "tool",
      ts: TOOL_STREAM_TEST_NOW + 1,
      sessionKey: "main",
      data: { phase: "start", toolCallId: "call_1", name: "list_files", args: {} },
    });
    expect(visibleParts(host)).toEqual([{ text: COMMENTARY, itemId: "sig-1" }]);

    // The next cumulative chat snapshot still trims the retired prefix.
    host.chatStream = `${COMMENTARY}\n\nFound a match, now let me read the file`;
    expect(visibleParts(host)).toEqual([
      { text: COMMENTARY, itemId: "sig-1" },
      { text: "Found a match, now let me read the file", itemId: undefined },
    ]);
    vi.useRealTimers();
  });
  it("preserves complete formatting when the keyed projection flattens code", () => {
    const text = "```python\nif ready:\n    run()\n```";
    const host = createHost({ chatRunId: "run-1", chatStream: `${text}\n\n` });
    const flattened = text.replace(/\s+/gu, " ");
    preamble(host, "item-a", flattened, 1);
    preamble(host, "item-a", flattened, 2);
    expect(visibleParts(host)).toEqual([{ text, itemId: "item-a" }]);
  });

  it.each([`${COMMENTARY} More detail.`, `Before. ${COMMENTARY}`])(
    "does not retire a different complete occurrence: %s",
    (text) => {
      const host = createHost({ chatRunId: "run-1", chatStream: text });
      preamble(host, "item-a", COMMENTARY, 1);
      expect(visibleParts(host)).toEqual([
        { text: COMMENTARY, itemId: "item-a" },
        { text, itemId: undefined },
      ]);
    },
  );

  it("keeps already-owned bytes retired when a pending item is shortened", () => {
    const host = createHost({ chatRunId: "run-1", chatStream: "Checking tests" });
    preamble(host, "item-a", "Checking tests now", 1);
    preamble(host, "item-a", "Checking", 2);
    expect(visibleParts(host)).toEqual([{ text: "Checking", itemId: "item-a" }]);
    host.chatStream += "\n\nA later observation.";
    preamble(host, "item-a", "Checking", 3);
    expect(visibleParts(host)).toEqual([
      { text: "Checking", itemId: "item-a" },
      { text: "A later observation.", itemId: undefined },
    ]);
  });

  it("completes the owned prefix when the same pending item revises its text", () => {
    const host = createHost({ chatRunId: "run-1", chatStream: "Checking" });
    preamble(host, "item-a", "Checking files.", 1);
    preamble(host, "item-a", "Checking tests.", 2);
    host.chatStream = "Checking tests.";
    preamble(host, "item-a", "Checking tests.", 3);
    expect(visibleParts(host)).toEqual([{ text: "Checking tests.", itemId: "item-a" }]);
  });

  it("does not acquire a later occurrence for an item that never owned the earlier stream", () => {
    const host = createHost({ chatRunId: "run-1", chatStream: "Different text." });
    preamble(host, "item-a", COMMENTARY, 1);
    host.chatStream = COMMENTARY;
    preamble(host, "item-a", COMMENTARY, 2);
    expect(visibleParts(host)).toEqual([
      { text: COMMENTARY, itemId: "item-a" },
      { text: COMMENTARY, itemId: undefined },
    ]);
  });

  it("does not let a late item update consume a later identical occurrence", () => {
    const host = createHost({ chatRunId: "run-1", chatStream: `${COMMENTARY}\n\n` });
    preamble(host, "item-a", COMMENTARY, 1);
    host.chatStream += `${COMMENTARY}\n\n`;
    preamble(host, "item-a", COMMENTARY, 2);
    expect(visibleParts(host)).toEqual([
      { text: COMMENTARY, itemId: "item-a" },
      { text: COMMENTARY, itemId: undefined },
    ]);
    preamble(host, "item-b", COMMENTARY, 3);
    expect(visibleParts(host)).toEqual([
      { text: COMMENTARY, itemId: "item-a" },
      { text: COMMENTARY, itemId: "item-b" },
    ]);
  });

  it("retires a saved owner's first occurrence only, including delayed updates", () => {
    const saved = {
      role: "assistant",
      content: COMMENTARY,
      __openclaw: { id: "saved-a", seq: 1, runId: "run-1" },
      openclawStreamFallback: { itemId: "item-a", source: "segment" },
    };
    const host = createHost({
      chatRunId: "run-1",
      chatMessages: [saved],
      chatStream: `${COMMENTARY}\n\n`,
    });
    preamble(host, "item-a", COMMENTARY, 1);
    expect(visibleParts(host)).toEqual([]);
    expect(host.chatMessages).toEqual([saved]);
    host.chatStream += COMMENTARY;
    preamble(host, "item-a", COMMENTARY, 2);
    expect(visibleParts(host)).toEqual([{ text: COMMENTARY, itemId: undefined }]);
  });

  it("transfers the rolled-over occurrence without changing its tool boundary", () => {
    useToolStreamFakeTimers();
    const host = createHost({ chatRunId: "run-1", chatStream: `${COMMENTARY}\n\n` });
    handleAgentEvent(host, {
      runId: "run-1",
      seq: 1,
      stream: "tool",
      ts: TOOL_STREAM_TEST_NOW,
      sessionKey: "main",
      data: { phase: "start", toolCallId: "call_1", name: "list_files", args: {} },
    });
    preamble(host, "item-a", COMMENTARY, 2);
    expect(visibleParts(host)).toEqual([{ text: COMMENTARY, itemId: "item-a" }]);
    host.chatStream = `${COMMENTARY}\n\nLater text.`;
    preamble(host, "item-a", COMMENTARY, 3);
    expect(visibleParts(host)).toEqual([
      { text: COMMENTARY, itemId: "item-a" },
      { text: "Later text.", itemId: undefined },
    ]);
  });

  it("keeps leading code indentation on a later cumulative occurrence", () => {
    const code = "    execute()\n    finish()";
    const host = createHost({ chatRunId: "run-1", chatStream: `${COMMENTARY}\n\n` });
    preamble(host, "item-a", COMMENTARY, 1);
    host.chatStream += code;
    preamble(host, "item-b", "execute() finish()", 2);
    const parts = visibleAssistantStreamParts(host, {
      includeCurrent: true,
      isHiddenStreamText: isHiddenAssistantStreamText,
    });
    expect(parts.map((part) => part.text)).toEqual([COMMENTARY, code]);
  });

  it("does not reacquire an occurrence after an item is cleared", () => {
    const host = createHost({ chatRunId: "run-1", chatStream: `${COMMENTARY}\n\n` });
    preamble(host, "item-a", COMMENTARY, 1);
    preamble(host, "item-a", "", 2);
    host.chatStream += COMMENTARY;
    preamble(host, "item-a", COMMENTARY, 3);
    expect(visibleParts(host)).toEqual([
      { text: COMMENTARY, itemId: "item-a" },
      { text: COMMENTARY, itemId: undefined },
    ]);
  });
  it("keeps earlier different cumulative text visible when a later occurrence becomes keyed", () => {
    useToolStreamFakeTimers();
    const earlier = "The first observation stays visible.";
    const saved = {
      role: "assistant",
      content: earlier,
      __openclaw: { id: "earlier", seq: 1, runId: "run-1" },
    };
    const host = createHost({
      chatRunId: "run-1",
      chatStream: `${earlier}\n\n`,
      chatMessages: [saved],
    });
    reconcilePersistedAssistantStream(host);
    handleAgentEvent(host, {
      runId: "run-1",
      seq: 1,
      stream: "tool",
      ts: TOOL_STREAM_TEST_NOW,
      sessionKey: "main",
      data: { phase: "start", toolCallId: "call_1", name: "list_files", args: {} },
    });
    host.chatStream = `${earlier}\n\n${COMMENTARY}\n\n`;
    preamble(host, "item-a", COMMENTARY, 2);
    expect(host.chatMessages).toEqual([saved]);
    expect(visibleParts(host)).toEqual([{ text: COMMENTARY, itemId: "item-a" }]);
  });
  it("completes a keyed handoff when the last chat chunk arrives between update and end", () => {
    const text =
      "Commentary formatting proof.\n\n- first file\n- second file\n\n```python\nif ready:\n    execute()\n```";
    const host = createHost({ chatRunId: "run-1", chatStream: text.slice(0, -4) });
    const progress = text.replace(/\s+/gu, " ");
    preamble(host, "item-a", progress, 1);
    host.chatStream = text;
    preamble(host, "item-a", progress, 2);
    expect(visibleParts(host)).toEqual([{ text, itemId: "item-a" }]);
    host.chatStream += "\n\nA later observation.";
    preamble(host, "item-a", progress, 3);
    expect(visibleParts(host)).toEqual([
      { text, itemId: "item-a" },
      { text: "A later observation.", itemId: undefined },
    ]);
  });
});
