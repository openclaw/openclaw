import { describe, expect, it, vi } from "vitest";
import { watchTalkActivity } from "./activity.js";
import { createTalkSessionController } from "./talk-session-controller.js";

function createTalk(sessionId: string) {
  return createTalkSessionController({
    sessionId,
    mode: "realtime",
    transport: "gateway-relay",
    brain: "agent-consult",
  });
}

describe("Talk activity", () => {
  it("publishes anonymous lifecycle and speech activity", async () => {
    const events: Array<Record<string, unknown>> = [];
    const stop = watchTalkActivity((event) => {
      events.push(event);
    });
    const talk = createTalk("private-session-id");

    talk.emit({ type: "session.ready", payload: {} });
    const { turnId } = talk.startOutputAudio();
    talk.emit({ type: "output.audio.delta", turnId, payload: { transcript: "private" } });
    talk.finishOutputAudio({ turnId });
    talk.emit({ type: "session.closed", payload: {}, final: true });

    await vi.waitFor(() => expect(events.at(-1)?.type).toBe("ended"));
    expect(events.map((event) => event.type)).toEqual([
      "started",
      "state",
      "state",
      "speech",
      "state",
      "ended",
    ]);
    expect(new Set(events.map((event) => event.activityId)).size).toBe(1);
    expect(JSON.stringify(events)).not.toContain("private-session-id");
    expect(JSON.stringify(events)).not.toContain("private");
    stop();
  });

  it("stops publishing after unsubscribe and isolates watcher failures", async () => {
    const failing = watchTalkActivity(() => {
      throw new Error("plugin failure");
    });
    const listener = vi.fn();
    const stop = watchTalkActivity(listener);
    const talk = createTalk("activity-unsubscribe-test");

    expect(() => talk.emit({ type: "session.ready", payload: {} })).not.toThrow();
    await vi.waitFor(() => expect(listener).toHaveBeenCalled());
    stop();
    failing();
    listener.mockClear();
    talk.emit({ type: "session.closed", payload: {}, final: true });
    await new Promise<void>((resolve) => {
      queueMicrotask(resolve);
    });
    expect(listener).not.toHaveBeenCalled();
  });
});
