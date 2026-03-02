import type { App } from "@slack/bolt";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { RuntimeEnv } from "../../runtime.js";
import { createSlackMonitorContext } from "./context.js";

function createTestContext() {
  return createSlackMonitorContext({
    cfg: {
      channels: { slack: { enabled: true } },
      session: { dmScope: "main" },
    } as OpenClawConfig,
    accountId: "default",
    botToken: "xoxb-test",
    app: { client: {} } as App,
    runtime: {} as RuntimeEnv,
    botUserId: "U_BOT",
    teamId: "T_EXPECTED",
    apiAppId: "A_EXPECTED",
    historyLimit: 0,
    sessionScope: "per-sender",
    mainKey: "main",
    dmEnabled: true,
    dmPolicy: "open",
    allowFrom: [],
    allowNameMatching: false,
    groupDmEnabled: false,
    groupDmChannels: [],
    defaultRequireMention: true,
    groupPolicy: "allowlist",
    useAccessGroups: true,
    reactionMode: "off",
    reactionAllowlist: [],
    replyToMode: "off",
    threadHistoryScope: "thread",
    threadInheritParent: false,
    slashCommand: {
      enabled: true,
      name: "openclaw",
      ephemeral: true,
      sessionPrefix: "slack:slash",
    },
    textLimit: 4000,
    ackReactionScope: "group-mentions",
    mediaMaxBytes: 20 * 1024 * 1024,
    removeAckAfterReply: false,
  });
}

describe("createSlackMonitorContext isChannelAllowed closure correctness", () => {
  it("picks up channelsConfig mutations made after context creation", () => {
    const ctx = createTestContext();
    // Initially no channelsConfig — channel should be allowed under allowlist policy
    // only if groupPolicy is "open" (default is "allowlist", so blocked).
    ctx.groupPolicy = "open";
    expect(ctx.isChannelAllowed({ channelId: "C_ROOM", channelType: "channel" })).toBe(true);

    // Mutate ctx.channelsConfig to explicitly deny the channel.
    ctx.channelsConfig = { C_ROOM: { allow: false } };
    expect(ctx.isChannelAllowed({ channelId: "C_ROOM", channelType: "channel" })).toBe(false);
  });

  it("reflects channelsConfig set from undefined to a value", () => {
    const ctx = createTestContext();
    ctx.groupPolicy = "allowlist";
    // No channelsConfig — allowlist policy blocks all channels by default.
    expect(ctx.isChannelAllowed({ channelId: "C_NEW", channelType: "channel" })).toBe(false);

    // Set channelsConfig to allow the channel — closure must see the update.
    ctx.channelsConfig = { C_NEW: { allow: true } };
    expect(ctx.isChannelAllowed({ channelId: "C_NEW", channelType: "channel" })).toBe(true);
  });

  it("reflects dmEnabled mutations", () => {
    const ctx = createTestContext();
    // Default: dmEnabled is true
    expect(ctx.isChannelAllowed({ channelId: "D_DM", channelType: "im" })).toBe(true);

    ctx.dmEnabled = false;
    expect(ctx.isChannelAllowed({ channelId: "D_DM", channelType: "im" })).toBe(false);
  });

  it("reflects groupDmEnabled mutations", () => {
    const ctx = createTestContext();
    // Default: groupDmEnabled is false
    expect(ctx.isChannelAllowed({ channelId: "G_GDM", channelType: "mpim" })).toBe(false);

    ctx.groupDmEnabled = true;
    expect(ctx.isChannelAllowed({ channelId: "G_GDM", channelType: "mpim" })).toBe(true);
  });
});

describe("createSlackMonitorContext shouldDropMismatchedSlackEvent", () => {
  it("drops mismatched top-level app/team identifiers", () => {
    const ctx = createTestContext();
    expect(
      ctx.shouldDropMismatchedSlackEvent({
        api_app_id: "A_WRONG",
        team_id: "T_EXPECTED",
      }),
    ).toBe(true);
    expect(
      ctx.shouldDropMismatchedSlackEvent({
        api_app_id: "A_EXPECTED",
        team_id: "T_WRONG",
      }),
    ).toBe(true);
  });

  it("drops mismatched nested team.id payloads used by interaction bodies", () => {
    const ctx = createTestContext();
    expect(
      ctx.shouldDropMismatchedSlackEvent({
        api_app_id: "A_EXPECTED",
        team: { id: "T_WRONG" },
      }),
    ).toBe(true);
    expect(
      ctx.shouldDropMismatchedSlackEvent({
        api_app_id: "A_EXPECTED",
        team: { id: "T_EXPECTED" },
      }),
    ).toBe(false);
  });
});
