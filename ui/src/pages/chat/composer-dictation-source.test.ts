// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayEventFrame } from "../../api/gateway.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { ComposerDictationSession, placeComposerDictation } from "./composer-dictation-session.ts";
import {
  MockDictationAudioContext,
  useRealtimeTalkMicrophoneFixture,
} from "./talk/input.test-support.ts";

const sessions = new Set<ComposerDictationSession>();
useRealtimeTalkMicrophoneFixture();
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("AudioContext", MockDictationAudioContext);
});
afterEach(async () => {
  await Promise.all([...sessions].map((session) => session.cancel()));
  sessions.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function fixture() {
  const listeners = new Set<(frame: GatewayEventFrame) => void>();
  const client = createTestGatewayClient(async (method) =>
    method === "talk.session.create"
      ? {
          sessionId: "capture-1",
          transcriptionSessionId: "transcription-1",
          audio: { inputEncoding: "g711_ulaw", inputSampleRateHz: 8000 },
        }
      : {},
  );
  vi.spyOn(client, "addEventListener").mockImplementation((listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  });
  const onTranscriptChange = vi.fn();
  const session = new ComposerDictationSession(
    client,
    {
      onReady: vi.fn(),
      onError: vi.fn(),
      onTranscriptChange,
    },
    { inputDeviceId: undefined },
  );
  sessions.add(session);
  await session.start();
  return {
    session,
    onTranscriptChange,
    emit: (payload: Record<string, unknown>) => {
      for (const listener of listeners) {
        listener({
          type: "event",
          event: "talk.event",
          payload: {
            transcriptionSessionId: "transcription-1",
            ...payload,
          },
        });
      }
    },
  };
}

describe("dictation source finality and revision ownership", () => {
  it("accepts the buffered relay final between Stop and turn-end lifecycle markers", async () => {
    const { session, emit } = await fixture();
    const finishing = session.finish();
    const text = "Um, I need fifteen. Sorry, fifty copies.";
    for (const [seq, type, value] of [
      [10, "input.audio.committed", ""],
      [11, "transcript.done", text],
      [12, "turn.ended", ""],
    ] as const) {
      emit({ type: "transcript", final: true, text: value, talkEvent: { type, seq } });
    }
    emit({ type: "close", reason: "completed", talkEvent: { type: "session.closed", seq: 13 } });
    await expect(finishing).resolves.toBe(text);
    expect(session.cleanupSource(text)).toMatchObject({ revision: 1, isFinal: true });
  });

  it("rejects sequenced replay across Stop while preserving repeated words from distinct events", async () => {
    const { session, emit, onTranscriptChange } = await fixture();
    emit({ type: "partial", text: "preview", talkEvent: { seq: 4 } });
    const preview = session.cleanupSource(session.transcriptSnapshot());
    expect(preview).toEqual({ id: "capture-1", revision: 1, text: "preview", isFinal: false });
    emit({ type: "partial", text: "stale", talkEvent: { seq: 3 } });
    emit({ type: "transcript", final: true, text: "duplicate", talkEvent: { seq: 4 } });
    expect(session.transcriptSnapshot()).toBe("preview");
    expect(onTranscriptChange).toHaveBeenCalledTimes(1);
    emit({ type: "transcript", final: true, text: "very", talkEvent: { seq: 5 } });
    emit({ type: "transcript", final: true, text: "very", talkEvent: { seq: 6 } });
    const finishing = session.finish();
    expect(session.cleanupSource("very very").isFinal).toBe(false);
    emit({ type: "transcript", final: true, text: "very", talkEvent: { seq: 6 } });
    emit({ type: "partial", text: "rewind", talkEvent: { seq: 5 } });
    emit({ type: "transcript", final: true, text: "important", talkEvent: { seq: 7 } });
    emit({ type: "close", reason: "completed" });
    const text = await finishing;
    expect(text).toBe("very very important");
    expect(session.cleanupSource(text)).toEqual({
      id: "capture-1",
      revision: 4,
      text,
      isFinal: true,
    });
    expect(session.cleanupSource("unrelated text").isFinal).toBe(false);
    expect(Object.isFrozen(preview)).toBe(true);
    expect(preview).toEqual({ id: "capture-1", revision: 1, text: "preview", isFinal: false });
  });

  it("preserves the unsequenced provider path without deduplicating equal final text", async () => {
    const { session, emit } = await fixture();
    emit({ type: "transcript", final: true, text: "very" });
    emit({ type: "transcript", final: true, text: "very" });
    const finishing = session.finish();
    emit({ type: "transcript", final: true, text: "important" });
    emit({ type: "close", reason: "completed" });
    const text = await finishing;
    expect(text).toBe("very very important");
    expect(session.cleanupSource(text)).toEqual({
      id: "capture-1",
      revision: 3,
      text,
      isFinal: true,
    });
  });

  it.each(["completed", "timeout", "disconnect", "error"])(
    "retains the existing partial fallback without promoting a %s drain to final",
    async (outcome) => {
      const { session, emit } = await fixture();
      const original = "um please call me tomorrow";
      emit({ type: "partial", text: original, talkEvent: { seq: 1 } });
      const finishing = session.finish();
      await vi.advanceTimersByTimeAsync(0);
      if (outcome === "completed") {
        emit({ type: "close", reason: "completed" });
      } else if (outcome === "disconnect") {
        session.markGatewayDisconnected();
      } else if (outcome === "error") {
        emit({
          type: "transcript",
          text: "discard failed replacement",
          final: true,
          talkEvent: { seq: 2 },
        });
        emit({ type: "error", message: "Synthetic provider failure" });
      } else {
        await vi.advanceTimersByTimeAsync(10_000);
      }
      const text = await finishing;
      expect(text).toBe(original);
      expect(session.cleanupSource(text).isFinal).toBe(false);
    },
  );

  it.each(["timeout", "disconnect", "error"])(
    "does not certify a completed capture merely because a final segment preceded %s",
    async (outcome) => {
      const { session, emit } = await fixture();
      emit({ type: "transcript", final: true, text: "retained segment", talkEvent: { seq: 1 } });
      const finishing = session.finish();
      await vi.advanceTimersByTimeAsync(0);
      if (outcome === "timeout") {
        await vi.advanceTimersByTimeAsync(10_000);
      } else if (outcome === "disconnect") {
        session.markGatewayDisconnected();
      } else {
        emit({ type: "close", reason: "error" });
      }
      const text = await finishing;
      expect(text).toBe("retained segment");
      expect(session.cleanupSource(text).isFinal).toBe(false);
    },
  );

  it("observes a late partial's sequence and finality without changing Off fallback text", async () => {
    const { session, emit } = await fixture();
    emit({ type: "transcript", final: true, text: "first segment", talkEvent: { seq: 1 } });
    const finishing = session.finish();
    emit({ type: "partial", text: "unfinished tail", talkEvent: { seq: 3 } });
    emit({ type: "transcript", final: true, text: "stale tail", talkEvent: { seq: 2 } });
    emit({ type: "close", reason: "completed" });
    const text = await finishing;
    expect(text).toBe("first segment");
    expect(session.cleanupSource(text)).toEqual({
      id: "capture-1",
      revision: 2,
      text,
      isFinal: false,
    });
  });

  it("retires finalization on cancellation and ignores malformed supplied sequence metadata", async () => {
    const { session, emit } = await fixture();
    for (const seq of ["1", -1, 0.5, Number.NaN]) {
      emit({ type: "transcript", final: true, text: "invalid", talkEvent: { seq } });
    }
    expect(session.transcriptSnapshot()).toBe("");
    emit({ type: "partial", text: "retained only on review", talkEvent: { seq: 1 } });
    const finishing = session.finish();
    await session.cancel();
    emit({ type: "transcript", final: true, text: "late", talkEvent: { seq: 2 } });
    emit({ type: "close", reason: "completed" });
    await expect(finishing).resolves.toBe("");
    expect(session.cleanupSource("").isFinal).toBe(false);
  });
});

it("placeComposerDictation spaces inserted and replaced selections", () => {
  const place = (start: number, end: number, spoken: string) =>
    placeComposerDictation(spoken, null, { start, end, value: "hello world" });
  expect(place(6, 6, "brave new")).toMatchObject({ value: "hello brave new world", caret: 16 });
  expect(place(6, 11, "there")).toMatchObject({ value: "hello there", caret: 11 });
});
