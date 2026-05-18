import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { hasPendingHeartbeatWake, resetHeartbeatWakeStateForTests } from "./heartbeat-wake.js";
import {
  enqueueNotificationSystemEvent,
  resolveNotificationWakePolicy,
} from "./notification-system-events.js";
import { drainSystemEvents, peekSystemEvents, resetSystemEventsForTest } from "./system-events.js";

describe("notification system events", () => {
  beforeEach(() => {
    resetSystemEventsForTest();
    resetHeartbeatWakeStateForTests();
  });

  it("queues by default without waking heartbeat", () => {
    const result = enqueueNotificationSystemEvent({
      cfg: {},
      channel: "telegram",
      sessionKey: "agent:main:telegram:direct:1",
      family: "reactions",
      text: "Telegram reaction added",
      contextKey: "telegram:reaction:add:1",
    });

    expect(result).toEqual({ status: "enqueued", policy: "queue", enqueued: true, woke: false });
    expect(peekSystemEvents("agent:main:telegram:direct:1")).toEqual(["Telegram reaction added"]);
    expect(hasPendingHeartbeatWake()).toBe(false);
  });

  it("wakes only after a configured event is enqueued", () => {
    const cfg: OpenClawConfig = {
      channels: {
        telegram: {
          accounts: {
            default: { notificationWake: { reactions: "wake" } },
          },
        },
      },
    };

    const result = enqueueNotificationSystemEvent({
      cfg,
      channel: "telegram",
      accountId: "default",
      agentId: "main",
      sessionKey: "agent:main:telegram:direct:1",
      family: "reactions",
      text: "Telegram reaction added",
      contextKey: "telegram:reaction:add:1",
    });

    expect(result).toEqual({ status: "enqueued", policy: "wake", enqueued: true, woke: true });
    expect(hasPendingHeartbeatWake()).toBe(true);
  });

  it("does not wake for duplicate events", () => {
    const cfg: OpenClawConfig = {
      channels: { discord: { notificationWake: { reactions: "wake" } } },
    };
    const base = {
      cfg,
      channel: "discord",
      sessionKey: "agent:main:discord:direct:1",
      family: "reactions" as const,
      text: "Discord reaction added",
      contextKey: "discord:reaction:add:1",
    };

    enqueueNotificationSystemEvent(base);
    resetHeartbeatWakeStateForTests();
    const result = enqueueNotificationSystemEvent(base);

    expect(result).toEqual({ status: "deduped", policy: "wake", enqueued: false, woke: false });
    expect(hasPendingHeartbeatWake()).toBe(false);
  });

  it("skips enqueue when policy is off", () => {
    const enqueueSystemEvent = vi.fn(() => true);
    const result = enqueueNotificationSystemEvent({
      cfg: { channels: { discord: { notificationWake: { reactions: "off" } } } },
      channel: "discord",
      sessionKey: "agent:main:discord:direct:1",
      family: "reactions",
      text: "Discord reaction added",
      enqueueSystemEvent,
    });

    expect(result).toEqual({ status: "skipped", policy: "off", enqueued: false, woke: false });
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(drainSystemEvents("agent:main:discord:direct:1")).toEqual([]);
  });

  it("resolves account policy before agent and global defaults", () => {
    const cfg: OpenClawConfig = {
      notifications: { systemEvents: { reactions: "wake" } },
      agents: {
        defaults: { notificationWake: { reactions: "off" } },
        list: [{ id: "ops", notificationWake: { reactions: "queue" } }],
      },
      channels: {
        defaults: { notificationWake: { reactions: "off" } },
        discord: {
          notificationWake: { reactions: "wake" },
          accounts: { prod: { notificationWake: { reactions: "queue" } } },
        },
      },
    };

    expect(
      resolveNotificationWakePolicy({
        cfg,
        channel: "discord",
        accountId: "prod",
        agentId: "ops",
        family: "reactions",
      }),
    ).toBe("queue");
  });

  it("normalizes account and agent ids before resolving policy", () => {
    const cfg: OpenClawConfig = {
      agents: {
        list: [{ id: "Ops Team", notificationWake: { reactions: "wake" } }],
      },
      channels: {
        telegram: {
          accounts: {
            "Work Account": { notificationWake: { reactions: "off" } },
          },
        },
      },
    };

    expect(
      resolveNotificationWakePolicy({
        cfg,
        channel: "telegram",
        accountId: "work-account",
        agentId: "ops-team",
        family: "reactions",
      }),
    ).toBe("off");

    expect(
      resolveNotificationWakePolicy({
        cfg: { agents: cfg.agents, channels: { telegram: {} } },
        channel: "telegram",
        agentId: "ops-team",
        family: "reactions",
      }),
    ).toBe("wake");
  });
});
