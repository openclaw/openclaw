import { describe, expect, it, vi } from "vitest";
import {
  createRealtimeVoiceOutputMediaSession,
  type RealtimeVoiceOutputMediaEvent,
} from "./output-media.js";

describe("realtime voice output media", () => {
  it("does no delivery work when the session has no owner listener", () => {
    const session = createRealtimeVoiceOutputMediaSession();

    expect(session.sendAudio(new Uint8Array([1, 0]))).toBe(true);
    expect(session.clear("barge-in")).toBe(2);
    expect(() => session.end("completed")).not.toThrow();
  });

  it("delivers ordered, copied media only to the owning session listener", async () => {
    const events: RealtimeVoiceOutputMediaEvent[] = [];
    const session = createRealtimeVoiceOutputMediaSession({
      onEvent: (event) => events.push(event),
    });
    const pcm = new Uint8Array([1, 0, 2, 0]);

    session.setState("listening");
    session.sendAudio(pcm);
    pcm.fill(9);
    await vi.waitFor(() => expect(events.some((event) => event.type === "audio")).toBe(true));
    session.clear("barge-in");
    session.end("completed");

    await vi.waitFor(() => expect(events.at(-1)?.type).toBe("session.end"));
    expect(events.map((event) => event.type)).toEqual([
      "session.start",
      "state",
      "state",
      "state",
      "audio",
      "clear",
      "clear",
      "state",
      "session.end",
    ]);
    const audio = events.find(
      (event): event is Extract<RealtimeVoiceOutputMediaEvent, { type: "audio" }> =>
        event.type === "audio",
    );
    expect(audio?.pcm).toEqual(new Uint8Array([1, 0, 2, 0]));
    expect(audio).toMatchObject({ generation: 1, sequence: 0, ptsMs: 0 });
    expect(events.at(-1)).toMatchObject({ generation: 3, reason: "completed" });
  });

  it("isolates listener failures from playback", async () => {
    const onEvent = vi.fn(async () => {
      throw new Error("owner failed");
    });
    const session = createRealtimeVoiceOutputMediaSession({ onEvent });

    expect(session.sendAudio(new Uint8Array([1, 0]))).toBe(true);
    await vi.waitFor(() => expect(onEvent).toHaveBeenCalled());
    expect(session.sendAudio(new Uint8Array([2, 0]))).toBe(true);
  });
});
