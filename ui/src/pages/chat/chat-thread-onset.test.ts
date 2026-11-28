// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readHandoffDisplay } from "./chat-sessions-yield.ts";
import { buildChatItems } from "./chat-thread-build.ts";
import {
  message as chatMessage,
  nativeMessage,
  person as senderProfile,
  text as textBlock,
  toolResult as resultMessage,
} from "./chat-thread-fixtures.test-support.ts";
import { createProps } from "./chat-thread.test-support.ts";
import {
  buildCachedChatItems,
  getChatItemsGeneration,
  resetChatThreadState,
} from "./chat-thread.ts";

beforeEach(() => resetChatThreadState());

const assistant = chatMessage.bind(null, "assistant");
const nativeUser = (sendId: string, text: unknown, timestamp: number, metadata: object = {}) =>
  nativeMessage("user", text, timestamp, { idempotencyKey: `${sendId}:user`, ...metadata });

describe("first streamed text", () => {
  it.each([
    { initialStream: null, finalizing: false },
    { initialStream: "", finalizing: false },
    { initialStream: null, finalizing: true },
    { initialStream: "", finalizing: true },
  ])(
    "adds first text after $initialStream (answer=$finalizing) without rescanning history or changing its placement and attribution",
    ({ initialStream, finalizing }) => {
      const read = vi.fn(Reflect.get);
      const runId = "onset-run";
      const history = Array.from({ length: 1_000 }, (_, index) =>
        chatMessage(index % 2 === 0 ? "user" : "assistant", `message ${index}`, index),
      );
      const messages = [
        ...history,
        nativeUser(runId, "Create a preview", 1_001, { id: "request", ...senderProfile("alice") }),
        nativeMessage(
          "assistant",
          [
            textBlock("Preview"),
            {
              type: "canvas",
              preview: {
                kind: "canvas",
                surface: "assistant_message",
                render: "url",
                viewId: "cv_onset",
              },
            },
          ],
          1_002,
          { id: "preview", runId },
        ),
        nativeUser("steer", "Keep going", 1_003, {
          id: "steer",
          steerTargetRunId: runId,
          ...senderProfile("bob"),
        }),
        nativeUser("later", "Later request", 2_000, { id: "later", ...senderProfile("alice") }),
      ].map((message) => new Proxy(message, { get: read }));
      const input = createProps({
        messages,
        runId,
        runActive: true,
        runWorking: true,
        runFinalizing: false,
        stream: initialStream,
        streamStartedAt: 1_001,
      });
      const waiting = buildCachedChatItems(input);
      const generation = getChatItemsGeneration(waiting);
      const indicator = waiting.find((item) => item.kind === "reading-indicator");
      const stream = 'Ready [embed ref="cv_onset" /]';
      const firstText = { ...input, stream, runWorking: !finalizing, runFinalizing: finalizing };
      const expected = buildChatItems(firstText);
      read.mockClear();

      const started = buildCachedChatItems(firstText);

      expect(read).not.toHaveBeenCalled();
      expect(started).toEqual(expected);
      expect(started[0]).toBe(waiting[0]);
      expect(waiting.some((item) => item.kind === "stream")).toBe(false);
      expect(getChatItemsGeneration(started)).toBeGreaterThan(generation);
      const index = started.findIndex((item) => item.kind === "stream" && item.isStreaming);
      expect(started[index]).toMatchObject({ text: "Ready ", replyPreviousMessageId: "steer" });
      if (finalizing) {
        expect(started).not.toContain(indicator);
      } else {
        expect(started[index + 1]).toBe(indicator);
      }
      read.mockClear();
      expect(buildCachedChatItems({ ...firstText, stream: `${stream} now` })).toBe(started);
      expect(read).not.toHaveBeenCalled();
    },
  );

  it("rebuilds handoff resume facts when its first text arrives", () => {
    const input = createProps({
      runId: "parent-run",
      runWorking: true,
      stream: "",
      streamStartedAt: 3_000,
      messages: [
        nativeUser("parent-run", "Start work", 1_000),
        assistant(
          [{ type: "toolcall", id: "yield", name: "sessions_yield", arguments: {} }],
          2_000,
          { runId: "parent-run" },
        ),
        resultMessage(
          "yield",
          "sessions_yield",
          '{"status":"yielded","acknowledgment":"Waiting"}',
          2_001,
          {
            runId: "parent-run",
          },
        ),
      ],
    });
    const handoffs = (items: ReturnType<typeof buildChatItems>) =>
      items.flatMap((item) =>
        item.kind === "group"
          ? item.messages.map(({ message }) => readHandoffDisplay(message)).filter(Boolean)
          : [],
      );
    expect(handoffs(buildCachedChatItems(input))).toEqual([{ yieldedAt: 2_000 }]);

    const resumed = buildCachedChatItems({ ...input, stream: "Resuming now" });

    expect(handoffs(resumed)).toEqual([{ yieldedAt: 2_000, resumedAt: 3_000 }]);
    expect(resumed).toEqual(buildChatItems({ ...input, stream: "Resuming now" }));
  });
});
