import { describe, expect, it } from "vitest";
import { buildChannelHealthSummaryLine } from "./reply/commands-status.js";
import { buildStatusMessage } from "./status.js";

describe("buildChannelHealthSummaryLine", () => {
  it("omits channel line when no channels are configured", () => {
    const line = buildChannelHealthSummaryLine([
      {
        id: "whatsapp",
        snapshot: { configured: false, enabled: true },
      },
      {
        id: "slack",
        snapshot: { configured: false, enabled: true },
      },
    ]);

    expect(line).toBeUndefined();
  });

  it("renders healthy channels with checkmarks", () => {
    const line = buildChannelHealthSummaryLine([
      {
        id: "whatsapp",
        snapshot: {
          configured: true,
          enabled: true,
          connected: true,
          running: true,
        },
      },
      {
        id: "slack",
        snapshot: {
          configured: true,
          enabled: true,
        },
      },
    ]);

    expect(line).toBe("📡 Channels: ✅ whatsapp, ✅ slack");
  });

  it("renders mixed healthy and unhealthy channels", () => {
    const line = buildChannelHealthSummaryLine([
      {
        id: "whatsapp",
        snapshot: {
          configured: true,
          enabled: true,
          connected: true,
          running: true,
        },
      },
      {
        id: "telegram",
        snapshot: {
          configured: true,
          enabled: true,
          connected: false,
          running: true,
        },
      },
    ]);

    expect(line).toBe("📡 Channels: ✅ whatsapp, ❌ telegram");
  });

  it("renders disabled channels with a black circle", () => {
    const line = buildChannelHealthSummaryLine([
      {
        id: "signal",
        snapshot: {
          configured: true,
          enabled: false,
        },
      },
    ]);

    expect(line).toBe("📡 Channels: ⚫ signal");
  });

  it("truncates error messages to 30 characters", () => {
    const longError = "123456789012345678901234567890EXTRA";
    const line = buildChannelHealthSummaryLine([
      {
        id: "telegram",
        snapshot: {
          configured: true,
          enabled: true,
          lastError: longError,
        },
      },
    ]);

    expect(line).toBe("📡 Channels: ❌ telegram (123456789012345678901234567890)");
  });
});

describe("buildStatusMessage channel line placement", () => {
  it("places channel health line between subagents and options", () => {
    const text = buildStatusMessage({
      agent: { model: "anthropic/claude-opus-4-5" },
      sessionEntry: { sessionId: "session-1", updatedAt: 0 },
      sessionKey: "agent:main:main",
      queue: { mode: "collect", depth: 0 },
      subagentsLine: "🤖 Subagents: 1 active",
      channelsLine: "📡 Channels: ✅ whatsapp",
    });

    const lines = text.split("\n");
    const subagentsIndex = lines.findIndex((line) => line === "🤖 Subagents: 1 active");
    const channelsIndex = lines.findIndex((line) => line === "📡 Channels: ✅ whatsapp");
    const optionsIndex = lines.findIndex((line) => line.startsWith("⚙️ "));

    expect(subagentsIndex).toBeGreaterThanOrEqual(0);
    expect(channelsIndex).toBe(subagentsIndex + 1);
    expect(optionsIndex).toBe(channelsIndex + 1);
  });
});
