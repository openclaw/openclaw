import { describe, expect, it } from "vitest";
import { HEARTBEAT_PROMPT } from "../auto-reply/heartbeat.js";
import type { ClawdisConfig } from "../config/config.js";
import {
  resolveHeartbeatDeliveryTarget,
  resolveHeartbeatIntervalMs,
  resolveHeartbeatPrompt,
} from "./heartbeat-runner.js";

describe("resolveHeartbeatIntervalMs", () => {
  it("returns null when unset or invalid", () => {
    expect(resolveHeartbeatIntervalMs({})).toBeNull();
    expect(
      resolveHeartbeatIntervalMs({ agent: { heartbeat: { every: "0m" } } }),
    ).toBeNull();
    expect(
      resolveHeartbeatIntervalMs({ agent: { heartbeat: { every: "oops" } } }),
    ).toBeNull();
  });

  it("parses duration strings with minute defaults", () => {
    expect(
      resolveHeartbeatIntervalMs({ agent: { heartbeat: { every: "5m" } } }),
    ).toBe(5 * 60_000);
    expect(
      resolveHeartbeatIntervalMs({ agent: { heartbeat: { every: "5" } } }),
    ).toBe(5 * 60_000);
    expect(
      resolveHeartbeatIntervalMs({ agent: { heartbeat: { every: "2h" } } }),
    ).toBe(2 * 60 * 60_000);
  });
});

describe("resolveHeartbeatPrompt", () => {
  it("uses the default prompt when unset", () => {
    expect(resolveHeartbeatPrompt({})).toBe(HEARTBEAT_PROMPT);
  });

  it("uses a trimmed override when configured", () => {
    const cfg: ClawdisConfig = {
      agent: { heartbeat: { prompt: "  ping  " } },
    };
    expect(resolveHeartbeatPrompt(cfg)).toBe("ping");
  });
});

describe("resolveHeartbeatDeliveryTarget", () => {
  const baseEntry = {
    sessionId: "sid",
    updatedAt: Date.now(),
  };

  it("respects target none", () => {
    const cfg: ClawdisConfig = {
      agent: { heartbeat: { target: "none" } },
    };
    expect(resolveHeartbeatDeliveryTarget({ cfg, entry: baseEntry })).toEqual({
      channel: "none",
      reason: "target-none",
    });
  });

  it("uses last route by default", () => {
    const cfg: ClawdisConfig = {};
    const entry = {
      ...baseEntry,
      lastChannel: "whatsapp" as const,
      lastTo: "+1555",
    };
    expect(resolveHeartbeatDeliveryTarget({ cfg, entry })).toEqual({
      channel: "whatsapp",
      to: "+1555",
    });
  });

  it("skips when last route is webchat", () => {
    const cfg: ClawdisConfig = {};
    const entry = {
      ...baseEntry,
      lastChannel: "webchat" as const,
      lastTo: "web",
    };
    expect(resolveHeartbeatDeliveryTarget({ cfg, entry })).toEqual({
      channel: "none",
      reason: "no-target",
    });
  });

  it("applies allowFrom fallback for WhatsApp targets", () => {
    const cfg: ClawdisConfig = {
      agent: { heartbeat: { target: "whatsapp", to: "+1999" } },
      routing: { allowFrom: ["+1555", "+1666"] },
    };
    const entry = {
      ...baseEntry,
      lastChannel: "whatsapp" as const,
      lastTo: "+1222",
    };
    expect(resolveHeartbeatDeliveryTarget({ cfg, entry })).toEqual({
      channel: "whatsapp",
      to: "+1555",
      reason: "allowFrom-fallback",
    });
  });

  it("keeps explicit telegram targets", () => {
    const cfg: ClawdisConfig = {
      agent: { heartbeat: { target: "telegram", to: "123" } },
    };
    expect(resolveHeartbeatDeliveryTarget({ cfg, entry: baseEntry })).toEqual({
      channel: "telegram",
      to: "123",
    });
  });
});
