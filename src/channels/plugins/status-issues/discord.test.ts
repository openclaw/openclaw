import { describe, expect, it } from "vitest";
import { collectDiscordStatusIssues } from "./discord.js";

describe("collectDiscordStatusIssues", () => {
  it("skips disabled accounts", () => {
    const issues = collectDiscordStatusIssues([
      {
        accountId: "disabled",
        enabled: false,
        configured: true,
      },
    ]);
    expect(issues).toEqual([]);
  });

  it("skips unconfigured accounts", () => {
    const issues = collectDiscordStatusIssues([
      {
        accountId: "default",
        enabled: true,
        configured: false,
      },
    ]);
    expect(issues).toEqual([]);
  });

  it("reports intent issue when Message Content Intent is disabled", () => {
    const issues = collectDiscordStatusIssues([
      {
        accountId: "default",
        enabled: true,
        configured: true,
        application: {
          intents: { messageContent: "disabled" },
        },
      },
    ]);

    expect(issues).toEqual([
      expect.objectContaining({
        channel: "discord",
        accountId: "default",
        kind: "intent",
      }),
    ]);
  });

  it("does not report intent issue when Message Content Intent is enabled", () => {
    const issues = collectDiscordStatusIssues([
      {
        accountId: "default",
        enabled: true,
        configured: true,
        application: {
          intents: { messageContent: "enabled" },
        },
      },
    ]);

    expect(issues).toEqual([]);
  });

  it("does not report intent issue when Message Content Intent is limited", () => {
    const issues = collectDiscordStatusIssues([
      {
        accountId: "default",
        enabled: true,
        configured: true,
        application: {
          intents: { messageContent: "limited" },
        },
      },
    ]);

    expect(issues).toEqual([]);
  });

  it("reports config issue when audit has unresolved channels", () => {
    const issues = collectDiscordStatusIssues([
      {
        accountId: "default",
        enabled: true,
        configured: true,
        audit: {
          unresolvedChannels: 3,
          channels: [],
        },
      },
    ]);

    expect(issues).toEqual([
      expect.objectContaining({
        channel: "discord",
        accountId: "default",
        kind: "config",
        message: expect.stringContaining("unresolvedChannels=3"),
      }),
    ]);
  });

  it("reports permissions issue for failed channel permission check", () => {
    const issues = collectDiscordStatusIssues([
      {
        accountId: "default",
        enabled: true,
        configured: true,
        audit: {
          channels: [
            {
              channelId: "123456789",
              ok: false,
              missing: ["VIEW_CHANNEL", "SEND_MESSAGES"],
            },
          ],
        },
      },
    ]);

    expect(issues).toEqual([
      expect.objectContaining({
        channel: "discord",
        accountId: "default",
        kind: "permissions",
        message: expect.stringContaining("123456789"),
      }),
    ]);
    expect(issues[0]?.message).toContain("VIEW_CHANNEL");
    expect(issues[0]?.message).toContain("SEND_MESSAGES");
  });

  it("includes match metadata in permissions issue message", () => {
    const issues = collectDiscordStatusIssues([
      {
        accountId: "default",
        enabled: true,
        configured: true,
        audit: {
          channels: [
            {
              channelId: "987654321",
              ok: false,
              error: "Forbidden",
              matchKey: "general",
              matchSource: "guilds.my-server.channels",
            },
          ],
        },
      },
    ]);

    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain("matchKey=general");
    expect(issues[0]?.message).toContain("matchSource=guilds.my-server.channels");
  });

  it("skips channels with ok=true in audit", () => {
    const issues = collectDiscordStatusIssues([
      {
        accountId: "default",
        enabled: true,
        configured: true,
        audit: {
          channels: [
            { channelId: "111", ok: true },
            { channelId: "222", ok: false },
          ],
        },
      },
    ]);

    // Only the failed channel should produce an issue
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain("222");
    expect(issues[0]?.message).not.toContain("111");
  });

  it("reports multiple issues for same account", () => {
    const issues = collectDiscordStatusIssues([
      {
        accountId: "default",
        enabled: true,
        configured: true,
        application: {
          intents: { messageContent: "disabled" },
        },
        audit: {
          unresolvedChannels: 1,
          channels: [{ channelId: "555", ok: false, error: "Missing access" }],
        },
      },
    ]);

    expect(issues).toHaveLength(3);
    expect(issues.map((i) => i.kind)).toEqual(["intent", "config", "permissions"]);
  });

  it("handles missing application and audit gracefully", () => {
    const issues = collectDiscordStatusIssues([
      {
        accountId: "default",
        enabled: true,
        configured: true,
      },
    ]);

    expect(issues).toEqual([]);
  });
});
