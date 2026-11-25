/**
 * Tests talk handoff coordination between gateway sessions and realtime state.
 */
import { describe, expect, it, vi } from "vitest";
import { createTalkHandoff, getTalkHandoff, revokeTalkHandoff } from "./handoff.js";

describe("talk handoff store", () => {
  it("creates an expiring managed-room handoff without storing the plaintext token", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-05T12:00:00.000Z"));

    const handoff = createTalkHandoff({
      sessionKey: "session:main",
      provider: "openai",
      model: "gpt-realtime-2",
      voice: "alloy",
      ttlMs: 5000,
    });
    const record = getTalkHandoff(handoff.id);

    expect(handoff).toMatchObject({
      roomId: `talk_${handoff.id}`,
      roomUrl: `/talk/rooms/talk_${handoff.id}`,
      sessionKey: "session:main",
      provider: "openai",
      model: "gpt-realtime-2",
      voice: "alloy",
      mode: "stt-tts",
      transport: "managed-room",
      brain: "agent-consult",
      createdAt: Date.parse("2026-05-05T12:00:00.000Z"),
      expiresAt: Date.parse("2026-05-05T12:00:05.000Z"),
    });
    expect(handoff).not.toHaveProperty("tokenHash");
    if (record === undefined) {
      throw new Error("expected stored talk handoff record");
    }
    expect(record.room.talk.recentEvents[0]).toMatchObject({
      type: "session.started",
      sessionId: `talk_${handoff.id}`,
      transport: "managed-room",
    });
    expect(record).not.toHaveProperty("token");

    vi.advanceTimersByTime(5001);
    expect(getTalkHandoff(handoff.id)).toBeUndefined();
    vi.useRealTimers();
  });

  it("revokes a handoff and records its final close event", () => {
    const handoff = createTalkHandoff({ sessionKey: "session:main" });
    const record = getTalkHandoff(handoff.id);

    expect(record).toMatchObject({
      roomId: handoff.roomId,
      sessionKey: "session:main",
    });
    revokeTalkHandoff(handoff.id);
    expect(record?.room.talk.recentEvents).toHaveLength(2);
    expect(record?.room.talk.recentEvents[1]).toMatchObject({
      type: "session.closed",
      sessionId: handoff.roomId,
      final: true,
      payload: { reason: "revoked" },
    });
    expect(getTalkHandoff(handoff.id)).toBeUndefined();
    revokeTalkHandoff(handoff.id);
    expect(record?.room.talk.recentEvents).toHaveLength(2);
  });

  it("isolates simultaneous handoffs for different sessions on the same host", () => {
    const first = createTalkHandoff({
      sessionKey: "agent:main:first",
      provider: "openai",
    });
    const second = createTalkHandoff({
      sessionKey: "agent:main:second",
    });

    expect(first.id).not.toBe(second.id);
    expect(first.roomId).not.toBe(second.roomId);
    expect(first.token).not.toBe(second.token);
    expect(getTalkHandoff(first.id)).toMatchObject({
      roomId: first.roomId,
      sessionKey: "agent:main:first",
      provider: "openai",
    });
    expect(getTalkHandoff(second.id)).toMatchObject({
      roomId: second.roomId,
      sessionKey: "agent:main:second",
    });
  });
});
