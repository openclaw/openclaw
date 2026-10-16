// Talk session controller tests cover controller state transitions.
import { describe, expect, it } from "vitest";
import type { TalkEvent } from "./talk-events.js";
import { createTalkSessionController, normalizeTalkTransport } from "./talk-session-controller.js";

const TEST_TALK_CONTEXT = {
  brain: "agent-consult",
  mode: "realtime",
  provider: "test",
  sessionId: "talk-session",
  transport: "gateway-relay",
} as const;

function expectTalkEvent(event: TalkEvent | undefined, expected: TalkEvent) {
  expect(event).toStrictEqual(expected);
}

function createController() {
  return createTalkSessionController(
    {
      ...TEST_TALK_CONTEXT,
      maxRecentEvents: 3,
    },
    { now: () => "2026-05-05T00:00:00.000Z" },
  );
}

describe("createTalkSessionController", () => {
  it("rejects stale turn completion before clearing the active turn", () => {
    const talk = createController();
    talk.ensureTurn({ turnId: "turn-old" });
    expect(talk.endTurn({ turnId: "turn-other" })).toEqual({
      ok: false,
      reason: "stale_turn",
    });
    expect(talk.activeTurnId).toBe("turn-old");

    const ended = talk.endTurn({ turnId: "turn-old", payload: { reason: "done" } });

    expect(ended).toStrictEqual({
      event: {
        ...TEST_TALK_CONTEXT,
        callId: undefined,
        captureId: undefined,
        final: true,
        id: "talk-session:2",
        itemId: undefined,
        parentId: undefined,
        payload: { reason: "done" },
        seq: 2,
        timestamp: "2026-05-05T00:00:00.000Z",
        turnId: "turn-old",
        type: "turn.ended",
      },
      ok: true,
      turnId: "turn-old",
    });
    expect(talk.activeTurnId).toBeUndefined();
  });

  it("tracks output audio lifecycle without duplicate started events", () => {
    const talk = createController();

    const first = talk.startOutputAudio({ payload: { callId: "call-1" } });
    const second = talk.startOutputAudio({ payload: { callId: "call-1" } });
    const done = talk.finishOutputAudio({ payload: { reason: "mark" } });

    expectTalkEvent(first.event, {
      ...TEST_TALK_CONTEXT,
      callId: undefined,
      captureId: undefined,
      final: undefined,
      id: "talk-session:2",
      itemId: undefined,
      parentId: undefined,
      payload: { callId: "call-1" },
      seq: 2,
      timestamp: "2026-05-05T00:00:00.000Z",
      turnId: "turn-1",
      type: "output.audio.started",
    });
    expect(second).toEqual({ turnId: "turn-1" });
    expectTalkEvent(done, {
      ...TEST_TALK_CONTEXT,
      callId: undefined,
      captureId: undefined,
      final: true,
      id: "talk-session:3",
      itemId: undefined,
      parentId: undefined,
      payload: { reason: "mark" },
      seq: 3,
      timestamp: "2026-05-05T00:00:00.000Z",
      turnId: "turn-1",
      type: "output.audio.done",
    });
    expect(talk.outputAudioActive).toBe(false);
  });

  it("preserves explicit null lifecycle payloads", () => {
    const talk = createController();

    const started = talk.startTurn({ payload: null });
    const ended = talk.endTurn({ payload: null, turnId: started.turnId });
    const audioStarted = talk.startOutputAudio({ payload: null });
    const audioDone = talk.finishOutputAudio({ payload: null });

    expect(started.event?.payload).toBeNull();
    expect(ended.ok ? ended.event.payload : undefined).toBeNull();
    expect(audioStarted.event?.payload).toBeNull();
    expect(audioDone?.payload).toBeNull();
  });

  it("clears stale output audio state when a replacement turn starts", () => {
    const talk = createController();

    talk.startOutputAudio({ turnId: "turn-old" });
    expect(talk.outputAudioActive).toBe(true);

    const current = talk.startTurn({ turnId: "turn-current" });

    expect(current).toStrictEqual({
      event: {
        ...TEST_TALK_CONTEXT,
        callId: undefined,
        captureId: undefined,
        final: undefined,
        id: "talk-session:3",
        itemId: undefined,
        parentId: undefined,
        payload: {},
        seq: 3,
        timestamp: "2026-05-05T00:00:00.000Z",
        turnId: "turn-current",
        type: "turn.started",
      },
      turnId: "turn-current",
    });
    expect(talk.activeTurnId).toBe("turn-current");
    expect(talk.outputAudioActive).toBe(false);
  });
});

describe("normalizeTalkTransport", () => {
  it("maps legacy public transport names to canonical names", () => {
    expect(normalizeTalkTransport(undefined)).toBeUndefined();
    expect(normalizeTalkTransport("webrtc-sdp")).toBe("webrtc");
    expect(normalizeTalkTransport("json-pcm-websocket")).toBe("provider-websocket");
    expect(normalizeTalkTransport("gateway-relay")).toBe("gateway-relay");
  });
});
