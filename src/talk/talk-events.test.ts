// Talk event tests cover realtime voice event normalization.
import { describe, expect, it } from "vitest";
import { createTalkEventSequencer } from "./talk-events.js";

describe("talk event envelope", () => {
  it("preserves turn, capture, and provider correlation fields", () => {
    const events = createTalkEventSequencer({
      sessionId: "session-voice",
      mode: "stt-tts",
      transport: "managed-room",
      brain: "agent-consult",
    });

    expect(
      events.next({
        type: "tool.call",
        turnId: "turn-1",
        captureId: "capture-1",
        callId: "call-1",
        itemId: "item-1",
        parentId: "parent-1",
        final: false,
        timestamp: "2026-05-05T12:00:01.000Z",
        payload: { name: "openclaw_agent_consult" },
      }),
    ).toEqual({
      id: "session-voice:1",
      sessionId: "session-voice",
      seq: 1,
      timestamp: "2026-05-05T12:00:01.000Z",
      mode: "stt-tts",
      transport: "managed-room",
      brain: "agent-consult",
      provider: undefined,
      type: "tool.call",
      turnId: "turn-1",
      captureId: "capture-1",
      callId: "call-1",
      itemId: "item-1",
      parentId: "parent-1",
      final: false,
      payload: { name: "openclaw_agent_consult" },
    });
  });

  it("rejects turn and capture scoped events without correlation ids", () => {
    const events = createTalkEventSequencer({
      sessionId: "session-voice",
      mode: "stt-tts",
      transport: "managed-room",
      brain: "agent-consult",
    });

    expect(() => events.next({ type: "turn.started", payload: {} })).toThrow(
      "Talk event turn.started requires turnId",
    );
    expect(() => events.next({ type: "capture.started", payload: {} })).toThrow(
      "Talk event capture.started requires captureId",
    );
  });
});
