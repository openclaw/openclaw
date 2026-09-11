/* @vitest-environment jsdom */

import { describe, expect, it } from "vitest";
import { createChatHandler } from "./realtime-talk-chat-handler.js";

function makePayload(runId: string, state: string, text?: string): ChatPayload {
  return { runId, state, message: { text } } as unknown as ChatPayload;
}

function makeFrame(runId: string, state: string, text?: string): GatewayEventFrame {
  return { type: "event", event: "chat", payload: makePayload(runId, state, text) };
}

type ChatPayload = Parameters<
  ReturnType<typeof createChatHandler>["handleEvent"]
>[0] extends infer E
  ? E extends { payload: infer P }
    ? P
    : never
  : never;

type GatewayEventFrame = { type: "event"; event: string; payload?: unknown };

describe("chat handler buffering and bounds", () => {
  it("buffers terminal events from unknown runs before follow-up discovery", () => {
    const handler = createChatHandler({
      runId: "run-1",
      emitTalkEvent: undefined,
      extractTextFromMessage: (m: unknown) => (m as { text?: string })?.text ?? "",
    });

    // An unrelated run's final event before follow-up discovery should be buffered
    expect(handler.handleEvent(makeFrame("run-unknown", "final", "buffered"))).toEqual({
      type: "buffer",
    });
    expect(handler.getAcceptedFollowupRunId()).toBeUndefined();
  });

  it("does not buffer progress events from unknown runs", () => {
    const handler = createChatHandler({
      runId: "run-1",
      emitTalkEvent: undefined,
      extractTextFromMessage: (m: unknown) => (m as { text?: string })?.text ?? "",
    });

    expect(handler.handleEvent(makeFrame("run-unknown", "progress"))).toEqual({
      type: "buffer",
    });
    // After accepting the follow-up runId, the buffer should have been cleared
    // and the progress event should not have been retained
    handler.setAcceptedFollowupRunId("run-2");
    expect(handler.replayBufferedFollowupEvents()).toEqual([]);
  });

  it("replays buffered terminal events after follow-up runId is discovered", () => {
    const handler = createChatHandler({
      runId: "run-1",
      emitTalkEvent: undefined,
      extractTextFromMessage: (m: unknown) => (m as { text?: string })?.text ?? "",
    });

    // Buffer some terminal events from the unknown follow-up run
    handler.handleEvent(makeFrame("run-2", "final", "first"));
    handler.handleEvent(makeFrame("run-2", "final", "second"));
    handler.handleEvent(makeFrame("run-2", "aborted", ""));

    // Discover the follow-up runId
    handler.setAcceptedFollowupRunId("run-2");

    const dispositions = handler.replayBufferedFollowupEvents();
    expect(dispositions).toHaveLength(3);
    expect(dispositions[0]).toEqual({ type: "terminal", text: "first" });
    expect(dispositions[1]).toEqual({ type: "terminal", text: "second" });
    expect(dispositions[2]).toEqual({ type: "aborted", errorMessage: undefined });
  });

  it("evicts oldest buffered events when exceeding MAX_BUFFERED_TERMINAL_EVENTS", () => {
    const handler = createChatHandler({
      runId: "run-1",
      emitTalkEvent: undefined,
      extractTextFromMessage: (m: unknown) => (m as { text?: string })?.text ?? "",
    });

    // Buffer 5 terminal events (MAX_BUFFERED_TERMINAL_EVENTS = 4)
    for (let i = 0; i < 5; i++) {
      handler.handleEvent(makeFrame("run-2", "final", `event-${i}`));
    }

    handler.setAcceptedFollowupRunId("run-2");
    const dispositions = handler.replayBufferedFollowupEvents();

    // Oldest event should have been evicted
    expect(dispositions).toHaveLength(4);
    expect(dispositions[0]).toEqual({ type: "terminal", text: "event-1" });
    expect(dispositions[3]).toEqual({ type: "terminal", text: "event-4" });
  });

  it("rejects an oversized terminal event rather than buffering it", () => {
    const handler = createChatHandler({
      runId: "run-1",
      emitTalkEvent: undefined,
      extractTextFromMessage: (m: unknown) => (m as { text?: string })?.text ?? "",
    });

    // A single event exceeding MAX_BUFFERED_BYTES (64 KiB) is dropped on its
    // own — it must never be retained as a lone exception in the buffer.
    const oversizedText = "x".repeat(70_000);
    expect(handler.handleEvent(makeFrame("run-2", "final", oversizedText))).toEqual({
      type: "buffer",
    });

    handler.setAcceptedFollowupRunId("run-2");
    expect(handler.replayBufferedFollowupEvents()).toEqual([]);
  });

  it("evicts oldest buffered events when exceeding MAX_BUFFERED_BYTES", () => {
    const handler = createChatHandler({
      runId: "run-1",
      emitTalkEvent: undefined,
      extractTextFromMessage: (m: unknown) => (m as { text?: string })?.text ?? "",
    });

    // Each payload is individually admissible under the byte ceiling, but the
    // aggregate exceeds it, so the oldest entries are evicted first. Chunks
    // are large enough that evicting a single oldest entry still leaves the
    // remaining pair over the ceiling, forcing continued eviction.
    const chunk = "y".repeat(40_000);
    handler.handleEvent(makeFrame("run-2", "final", `${chunk}-1`));
    handler.handleEvent(makeFrame("run-2", "aborted", `${chunk}-2`));
    handler.handleEvent(makeFrame("run-2", "error", `${chunk}-3`));

    handler.setAcceptedFollowupRunId("run-2");
    const dispositions = handler.replayBufferedFollowupEvents();

    // Only the most recent event should remain after aggregate eviction.
    expect(dispositions).toHaveLength(1);
    expect(dispositions[0]).toEqual({ type: "errored", errorMessage: undefined });
  });

  it("clears buffer when a matching event from the active run arrives", () => {
    const handler = createChatHandler({
      runId: "run-1",
      emitTalkEvent: undefined,
      extractTextFromMessage: (m: unknown) => (m as { text?: string })?.text ?? "",
    });

    handler.handleEvent(makeFrame("run-2", "final", "buffered"));
    handler.setAcceptedFollowupRunId("run-2");

    // An event from the now-active run-2 should be processed directly
    const result = handler.handleEvent(makeFrame("run-2", "final", "direct"));
    expect(result).toEqual({ type: "terminal", text: "direct" });

    // Buffer should be cleared — no stale events to replay
    expect(handler.replayBufferedFollowupEvents()).toEqual([]);
  });

  it("drops events for the wrong follow-up run after discovery", () => {
    const handler = createChatHandler({
      runId: "run-1",
      emitTalkEvent: undefined,
      extractTextFromMessage: (m: unknown) => (m as { text?: string })?.text ?? "",
    });

    // Discover follow-up as run-2
    handler.setAcceptedFollowupRunId("run-2");

    // An event for run-3 (not the accepted follow-up) should be dropped
    const result = handler.handleEvent(makeFrame("run-3", "final", "ignored"));
    expect(result).toEqual({ type: "buffer" });
  });
});
