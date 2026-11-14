// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { createRequireRecord } from "../../../../test/helpers/record.js";
import { extractToolCardsCached as extractToolCards } from "../../lib/chat/tool-cards.ts";
import {
  message as chatMessage,
  messagesOf as messagesIn,
  text as textBlock,
  toolResult as resultMessage,
} from "./chat-thread-fixtures.test-support.ts";
import { buildItems, type CachedChatItemsProps } from "./chat-thread.test-support.ts";
import { resetChatThreadState } from "./chat-thread.ts";

beforeEach(() => resetChatThreadState());

const user = chatMessage.bind(null, "user");
const assistant = chatMessage.bind(null, "assistant");
const toolCall = (id: string | undefined, name = "exec", args: unknown = {}) => ({
  type: "toolcall",
  ...(id === undefined ? {} : { id }),
  name,
  arguments: args,
});
const requireRecord = createRequireRecord("record", "expected-non-array-record");

function resetMessage(id: string) {
  return {
    role: "system",
    timestamp: 2_000,
    __openclaw: { kind: "reset", id },
  };
}

function messageGroups(props: Partial<CachedChatItemsProps>) {
  return buildItems(props).filter((item) => item.kind === "group");
}

function cardsIn(groups: ReturnType<typeof messageGroups>) {
  return messagesIn(groups).flatMap((message) => extractToolCards(message));
}

describe("distinct tool invocations", () => {
  const call = (id: string, name = "exec", runId: string | undefined = "run-a") =>
    assistant([{ type: "toolCall", id, name, arguments: { command: "echo ready" } }], 10, {
      runId,
    });
  const result = (id: string, text = "ready", runId: string | undefined = "run-a") =>
    resultMessage(id, "exec", [textBlock(text)], 20, { runId });
  const snapshot = (id: string, completed = true) =>
    assistant(
      [
        toolCall(undefined, "exec", { command: "echo ready" }),
        { type: "toolresult", name: "exec", text: completed ? "ready" : "working" },
      ],
      10,
      {
        runId: "run-a",
        toolCallId: id,
        __openclawToolStreamLive: true,
        __openclawToolStreamResultReceived: completed,
      },
    );
  const cardsFor = (messages: unknown[], toolMessages: unknown[] = []) =>
    cardsIn(messageGroups({ messages, toolMessages }));

  it("keeps a persisted empty terminal result over a partial snapshot", () => {
    const partial = snapshot("exec-1", false);
    expect(cardsFor([partial])[0]).toMatchObject({
      live: true,
      completed: false,
      outputText: "working",
    });
    const terminal = result("exec-1", "");
    const cards = cardsFor([terminal, partial]);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ completed: true, outputText: "" });
  });

  it.each(["reset", "reused"])(
    "does not relocate a live invocation across a boundary with %s ownership",
    (ownership) => {
      const persisted = call("exec-1");
      const live = snapshot("exec-1", false);
      const groups = messageGroups({
        runId: "run-a",
        messages: [
          user("Original request", 1),
          persisted,
          ...(ownership === "reset" ? [resetMessage("reset-invocation")] : []),
          user("Next request", 15),
          ...(ownership === "reused" ? [call("exec-1")] : []),
        ],
        toolMessages: [live],
      });
      const cards = cardsIn(groups);
      expect(cards).toHaveLength(2);
      expect(cards.filter((card) => card.outputText === "working")).toHaveLength(1);
    },
  );

  it("reconciles a multi-call snapshot without losing surrounding content or result metadata", () => {
    const attachment = { type: "image", data: "fixture-image", mimeType: "image/png" };
    const history = assistant(
      [
        textBlock("Before calls"),
        toolCall("a", "exec", { command: "first" }),
        toolCall("b", "exec", { command: "second" }),
        textBlock("After calls"),
      ],
      10,
      { runId: "run-a", __openclaw: { id: "transcript-call" } },
    );
    const terminal = result("a", "failed");
    terminal.content = [textBlock("failed"), attachment];
    terminal.details = { exitCode: 7, approvalReviewOutcome: "approved" };
    terminal.isError = true;
    const groups = messageGroups({
      messages: [history, terminal, result("b")],
      toolMessages: [snapshot("a"), snapshot("b")],
    });
    const entries = groups.flatMap((group) => group.messages);
    const cards = entries.flatMap((entry) => extractToolCards(entry.message));
    expect(cards).toHaveLength(2);
    expect(cards.find((card) => card.callId === "a")).toMatchObject({
      args: { command: "first" },
      outputText: "failed",
      isError: true,
      exitCode: 7,
      details: { exitCode: 7, approvalReviewOutcome: "approved" },
      messageId: "transcript-call",
    });
    const blocks = entries.flatMap((entry) => requireRecord(entry.message).content as unknown[]);
    expect(blocks).toContainEqual(attachment);
    expect(blocks).toContainEqual(textBlock("Before calls"));
    expect(blocks).toContainEqual(textBlock("After calls"));
    expect(blocks.findIndex((block) => requireRecord(block).text === "Before calls")).toBeLessThan(
      blocks.findIndex((block) => requireRecord(block).id === "a"),
    );
    expect(
      blocks.findIndex((block) => requireRecord(block).text === "After calls"),
    ).toBeGreaterThan(blocks.findLastIndex((block) => requireRecord(block).id === "b"));
  });

  it("keeps surrounding text in order when result references split a multi-call message", () => {
    const groups = messageGroups({
      messages: [
        assistant(
          [
            textBlock("before"),
            toolCall("a"),
            textBlock("between"),
            toolCall("b"),
            textBlock("after"),
          ],
          10,
        ),
        { ...result("a"), messageId: "a-result" },
        { ...result("b"), __openclaw: { id: "b-result" } },
      ],
    });
    const content = groups.flatMap((group) =>
      group.messages.flatMap(
        (entry) => requireRecord(entry.message).content as Record<string, unknown>[],
      ),
    );
    expect(content.map((block) => (block.type === "text" ? block.text : block.id))).toEqual([
      "before",
      "a",
      "a",
      "between",
      "b",
      "b",
      "after",
    ]);
  });

  it("reconciles identified siblings without losing anonymous fallback pairs", () => {
    const cards = cardsFor(
      [
        assistant(
          [
            toolCall("a", "exec", { command: "one" }),
            { type: "toolresult", name: "exec", text: "one done" },
            toolCall(undefined, "exec", { command: "two" }),
            { type: "toolresult", name: "exec", text: "two done" },
          ],
          10,
        ),
      ],
      [snapshot("a")],
    );
    expect(cards.map((card) => [card.callId, card.args, card.outputText])).toEqual([
      ["a", { command: "one" }, "one done"],
      [undefined, { command: "two" }, "two done"],
    ]);
  });

  it.each(["diffs", "tails"])(
    "keeps per-call live %s and conflicting-name outputs independent inside a batch",
    (mode) => {
      const live = ["a", "b"].map((id, index) =>
        Object.assign(
          snapshot(id, false),
          mode === "diffs"
            ? { __openclawToolStreamDiffStat: { added: index + 1, removed: 0 } }
            : { __openclawToolStreamLiveOutput: { text: `tail ${id}`, omittedChars: 12_000 } },
        ),
      );
      const cards = cardsFor(
        [
          assistant(
            [
              toolCall("a"),
              toolCall("b"),
              toolCall("conflict", "read", { path: "a" }),
              toolCall("conflict", "exec", { command: "pwd" }),
            ],
            10,
            { runId: "run-a" },
          ),
          resultMessage("conflict", "read", "read output", 20, { runId: "run-a" }),
          result("conflict", "exec output"),
        ],
        live,
      );
      expect(
        cards.slice(0, 2).map((card) => (mode === "diffs" ? card.liveDiffStat : card.liveOutput)),
      ).toEqual(
        mode === "diffs"
          ? [
              { added: 1, removed: 0 },
              { added: 2, removed: 0 },
            ]
          : [
              { text: "tail a", omittedChars: 12_000 },
              { text: "tail b", omittedChars: 12_000 },
            ],
      );
      expect(cards.slice(2).map((card) => [card.name, card.outputText])).toEqual([
        ["read", "read output"],
        ["exec", "exec output"],
      ]);
    },
  );
});
