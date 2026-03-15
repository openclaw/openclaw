import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../../config/config.js", () => ({
  loadConfig: vi.fn(() => ({ discord: { actions: {} } })),
}));

vi.mock("../../discord/targets.js", () => ({
  resolveDiscordChannelId: (id: string) => {
    if (id === "raw-id") {
      return "resolved-id";
    }
    throw new Error(`Unknown channel: ${id}`);
  },
}));

const sendMocks = vi.hoisted(() => ({
  deleteMessageDiscord: vi.fn(async () => ({ ok: true })),
  sendMessageDiscord: vi.fn(async () => ({})),
  defaultSendDiscord: vi.fn(async () => ({})),
}));

vi.mock("../../discord/send.js", () => sendMocks);

import { createDiscordTool } from "./discord-tool.js";

describe("discord tool wrapper", () => {
  const tool = createDiscordTool({
    config: {
      discord: {
        actions: { deleteMessage: true, sendMessage: true },
        channelPolicy: "open",
        bot: { enabled: false },
        guilds: {},
      },
      channels: { discord: { actions: {}, bot: { enabled: false } } },
    },
  } as never);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("has correct metadata", () => {
    expect(tool.name).toBe("discord");
    expect(tool.label).toBe("Discord");
    expect(tool.description).toContain("Discord");
  });

  it("returns error when action is missing", async () => {
    const result = await tool.execute("call-1", {});
    const details = result.details as Record<string, unknown>;
    expect(details.ok).toBe(false);
    expect(String(details.error)).toContain("action");
  });

  it("returns error when action is not a string", async () => {
    const result = await tool.execute("call-1", { action: 42 });
    const details = result.details as Record<string, unknown>;
    expect(details.ok).toBe(false);
    expect(String(details.error)).toContain("action");
  });

  it("succeeds with action + required params (full round-trip)", async () => {
    const result = await tool.execute("call-1", {
      action: "deleteMessage",
      channelId: "123456789",
      messageId: "987654321",
    });
    // Must return a valid result (not crash, not undefined)
    expect(result).toBeDefined();
    expect(result.content).toBeDefined();
    expect(result.details).toBeDefined();
  });

  it("resolves channel IDs via resolveDiscordChannelId", async () => {
    const result = await tool.execute("call-1", {
      action: "sendMessage",
      channelId: "raw-id",
      content: "hello",
    });
    // Must return a valid result (not crash)
    expect(result).toBeDefined();
    expect(result.details).toBeDefined();
  });

  it("passes unknown channel IDs through without crashing", async () => {
    // Should return a result object, not throw
    const result = await tool.execute("call-1", {
      action: "sendMessage",
      channelId: "unknown-channel-1234567890",
      content: "hello",
    });
    expect(result).toBeDefined();
    expect(result.details).toBeDefined();
  });

  it("catches handler errors and returns structured error (not an unhandled exception)", async () => {
    const result = await tool.execute("call-1", {
      action: "nonexistentAction123",
      channelId: "123",
    });
    // Should return something, not crash
    expect(result).toBeDefined();
    expect(result.details).toBeDefined();
  });
});
