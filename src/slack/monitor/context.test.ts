import type { App } from "@slack/bolt";
import { describe, expect, it, vi } from "vitest";
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
    typingReaction: "",
    ackReactionScope: "group-mentions",
    mediaMaxBytes: 20 * 1024 * 1024,
    removeAckAfterReply: false,
  });
}

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

describe("createSlackMonitorContext setSlackThreadStatus", () => {
  it("suppresses duplicate status writes for the same thread within the dedupe window", async () => {
    vi.useFakeTimers();
    try {
      const setStatus = vi.fn(async () => undefined);
      const ctx = createSlackMonitorContext({
        cfg: {
          channels: { slack: { enabled: true } },
          session: { dmScope: "main" },
        } as OpenClawConfig,
        accountId: "default",
        botToken: "xoxb-test",
        app: { client: { assistant: { threads: { setStatus } } } } as unknown as App,
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
        typingReaction: "",
        ackReactionScope: "group-mentions",
        mediaMaxBytes: 20 * 1024 * 1024,
        removeAckAfterReply: false,
      });

      await ctx.setSlackThreadStatus({ channelId: "C1", threadTs: "123", status: "is typing..." });
      await ctx.setSlackThreadStatus({ channelId: "C1", threadTs: "123", status: "is typing..." });
      expect(setStatus).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(5_001);
      await ctx.setSlackThreadStatus({ channelId: "C1", threadTs: "123", status: "is typing..." });
      expect(setStatus).toHaveBeenCalledTimes(2);

      await ctx.setSlackThreadStatus({ channelId: "C1", threadTs: "123", status: "" });
      expect(setStatus).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
