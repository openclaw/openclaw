import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  enqueueNotificationSystemEvent,
  resolveNotificationWakePolicy,
} from "./notification-system-events.js";
import { peekSystemEventEntries, resetSystemEventsForTest } from "./system-events.js";

const requestHeartbeat = vi.hoisted(() => vi.fn());

vi.mock("./heartbeat-wake.js", () => ({
  requestHeartbeat,
}));

describe("notification system events", () => {
  beforeEach(() => {
    resetSystemEventsForTest();
    requestHeartbeat.mockReset();
  });

  it("queues reaction notification events by default", () => {
    const result = enqueueNotificationSystemEvent({
      channel: "telegram",
      sessionKey: "telegram:direct:123",
      family: "reactions",
      text: "Telegram reaction added: thumbs up",
      contextKey: "telegram:reaction:123",
    });

    expect(result).toEqual({ status: "enqueued", policy: "queue", enqueued: true, woke: false });
    expect(peekSystemEventEntries("telegram:direct:123")).toHaveLength(1);
    expect(requestHeartbeat).not.toHaveBeenCalled();
  });

  it("skips enqueue when reaction notification wake policy is off", () => {
    const result = enqueueNotificationSystemEvent({
      cfg: { channels: { telegram: { notificationWake: { reactions: "off" } } } },
      channel: "telegram",
      sessionKey: "telegram:direct:123",
      family: "reactions",
      text: "Telegram reaction added: thumbs up",
      contextKey: "telegram:reaction:123",
    });

    expect(result).toEqual({ status: "skipped", policy: "off", enqueued: false, woke: false });
    expect(peekSystemEventEntries("telegram:direct:123")).toHaveLength(0);
    expect(requestHeartbeat).not.toHaveBeenCalled();
  });

  it("wakes only when the resolved reaction policy opts in", () => {
    const result = enqueueNotificationSystemEvent({
      cfg: { channels: { telegram: { notificationWake: { reactions: "wake" } } } },
      channel: "telegram",
      accountId: "default",
      agentId: "ops",
      sessionKey: "telegram:direct:123",
      family: "reactions",
      text: "Telegram reaction added: thumbs up",
      contextKey: "telegram:reaction:123",
      reason: "telegram-reaction",
    });

    expect(result).toEqual({ status: "enqueued", policy: "wake", enqueued: true, woke: true });
    expect(requestHeartbeat).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "notifications-event",
        intent: "immediate",
        reason: "notification-wake:telegram-reaction",
        agentId: "ops",
        sessionKey: "telegram:direct:123",
      }),
    );
  });

  it("prefers account policy before channel, agent, and global defaults", () => {
    const policy = resolveNotificationWakePolicy({
      cfg: {
        notifications: { systemEvents: { reactions: "wake" } },
        agents: {
          defaults: { notificationWake: { reactions: "off" } },
          list: [{ id: "ops", notificationWake: { reactions: "wake" } }],
        },
        channels: {
          defaults: { notificationWake: { reactions: "off" } },
          telegram: {
            notificationWake: { reactions: "wake" },
            accounts: { prod: { notificationWake: { reactions: "queue" } } },
          },
        },
      },
      channel: "telegram",
      accountId: "prod",
      agentId: "ops",
      family: "reactions",
    });

    expect(policy).toBe("queue");
  });

  it("does not wake deduplicated notification events", () => {
    const base = {
      cfg: { channels: { telegram: { notificationWake: { reactions: "wake" } } } },
      channel: "telegram",
      sessionKey: "telegram:direct:123",
      family: "reactions" as const,
      text: "Telegram reaction added: thumbs up",
      contextKey: "telegram:reaction:123",
    };

    enqueueNotificationSystemEvent(base);
    requestHeartbeat.mockClear();
    const result = enqueueNotificationSystemEvent(base);

    expect(result).toEqual({ status: "deduped", policy: "wake", enqueued: false, woke: false });
    expect(requestHeartbeat).not.toHaveBeenCalled();
  });
});
