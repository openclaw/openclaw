import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  emitBriefingEvent,
  onBriefingEvent,
  resetBriefingEventsForTests,
  type BriefingEvent,
} from "./briefing-events.js";

describe("briefing-events", () => {
  beforeEach(() => {
    resetBriefingEventsForTests();
  });
  afterEach(() => {
    resetBriefingEventsForTests();
  });

  it("emits frozen, monotonically sequenced events to all subscribers", () => {
    const received: BriefingEvent[] = [];
    const unsubscribeA = onBriefingEvent((event) => received.push(event));
    const otherReceived: BriefingEvent[] = [];
    const unsubscribeB = onBriefingEvent((event) => otherReceived.push(event));

    const first = emitBriefingEvent({
      type: "briefing.timeout",
      sessionKey: "agent:ghost:main",
      channel: "telegram",
      turnKey: "turn-1",
      maxTurnMs: 5000,
      elapsedMs: 5000,
      detail: "abort dispatched",
    });
    const second = emitBriefingEvent({
      type: "briefing.quarantine",
      sessionKey: "agent:ghost:main",
      channel: "telegram",
      batchKey: "agent:ghost:main:telegram",
      itemCount: 1,
      items: [{ itemId: "msg-1", reason: "policy" }],
      reasonCounts: { policy: 1 },
    });

    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);
    expect(typeof first.ts).toBe("number");
    expect(received).toHaveLength(2);
    expect(otherReceived).toHaveLength(2);
    expect(received[0]?.type).toBe("briefing.timeout");
    expect(received[1]?.type).toBe("briefing.quarantine");

    // Listener payloads are deep-frozen clones so callers cannot leak across.
    expect(() => {
      (received[0] as { foo?: string }).foo = "x";
    }).toThrow();

    unsubscribeA();
    unsubscribeB();
  });

  it("unsubscribe stops further deliveries", () => {
    const received: BriefingEvent[] = [];
    const unsubscribe = onBriefingEvent((event) => received.push(event));
    emitBriefingEvent({
      type: "briefing.timeout",
      sessionKey: "s",
      channel: "telegram",
      turnKey: "t-1",
      maxTurnMs: 1000,
      elapsedMs: 1000,
    });
    expect(received).toHaveLength(1);
    unsubscribe();
    emitBriefingEvent({
      type: "briefing.timeout",
      sessionKey: "s",
      channel: "telegram",
      turnKey: "t-2",
      maxTurnMs: 1000,
      elapsedMs: 1000,
    });
    expect(received).toHaveLength(1);
  });

  it("isolates listener exceptions so other listeners still receive", () => {
    const okReceived: BriefingEvent[] = [];
    onBriefingEvent(() => {
      throw new Error("listener boom");
    });
    onBriefingEvent((event) => okReceived.push(event));

    expect(() =>
      emitBriefingEvent({
        type: "briefing.timeout",
        sessionKey: "s",
        channel: "telegram",
        turnKey: "t",
        maxTurnMs: 1000,
        elapsedMs: 1000,
      }),
    ).not.toThrow();
    expect(okReceived).toHaveLength(1);
  });
});
