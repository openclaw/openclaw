import type { App } from "@slack/bolt";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import type { RuntimeEnv } from "../../../runtime.js";
import type { ResolvedSlackAccount } from "../../accounts.js";
import type { SlackMessageEvent } from "../../types.js";
import { createSlackMonitorContext } from "../context.js";
import { prepareSlackMessage } from "./prepare.js";

describe("prepareSlackMessage mention dedupe", () => {
  const baseConfig = {
    channels: { slack: { enabled: true } },
  } as OpenClawConfig;

  const account: ResolvedSlackAccount = {
    accountId: "default",
    enabled: true,
    botTokenSource: "config",
    appTokenSource: "config",
    config: {},
  };

  const buildCtx = (markMessageSeen: (channelId: string | undefined, ts?: string) => boolean) => {
    const ctx = createSlackMonitorContext({
      cfg: baseConfig,
      accountId: "default",
      botToken: "token",
      app: { client: {} } as App,
      runtime: {} as RuntimeEnv,
      botUserId: "BOT",
      teamId: "T1",
      apiAppId: "A1",
      historyLimit: 0,
      sessionScope: "per-sender",
      mainKey: "main",
      dmEnabled: true,
      dmPolicy: "open",
      allowFrom: [],
      groupDmEnabled: true,
      groupDmChannels: [],
      defaultRequireMention: true,
      groupPolicy: "open",
      useAccessGroups: false,
      reactionMode: "off",
      reactionAllowlist: [],
      replyToMode: "off",
      threadHistoryScope: "thread",
      threadInheritParent: false,
      slashCommand: {
        enabled: false,
        name: "openclaw",
        sessionPrefix: "slack:slash",
        ephemeral: true,
      },
      textLimit: 4000,
      ackReactionScope: "group-mentions",
      mediaMaxBytes: 1024,
      removeAckAfterReply: false,
    });

    ctx.resolveChannelName = async () => ({ name: "mission-control", type: "channel" });
    ctx.resolveUserName = async () => ({ name: "Alice" });
    ctx.markMessageSeen = markMessageSeen;

    return ctx;
  };

  it("does not mark seen when mention gating blocks", async () => {
    const markMessageSeen = vi.fn(() => false);
    const ctx = buildCtx(markMessageSeen);

    const message: SlackMessageEvent = {
      channel: "C1",
      channel_type: "channel",
      user: "U1",
      text: "hello",
      ts: "1.000",
    } as SlackMessageEvent;

    const prepared = await prepareSlackMessage({
      ctx,
      account,
      message,
      opts: { source: "message" },
    });

    expect(prepared).toBeNull();
    expect(markMessageSeen).not.toHaveBeenCalled();
  });

  it("marks seen after mention gating passes", async () => {
    const markMessageSeen = vi.fn(() => false);
    const ctx = buildCtx(markMessageSeen);

    const message: SlackMessageEvent = {
      channel: "C1",
      channel_type: "channel",
      user: "U1",
      text: "<@BOT> hello",
      ts: "1.000",
    } as SlackMessageEvent;

    const prepared = await prepareSlackMessage({
      ctx,
      account,
      message,
      opts: { source: "message" },
    });

    expect(prepared).toBeTruthy();
    expect(markMessageSeen).toHaveBeenCalledWith("C1", "1.000");
  });

  it("skips duplicates when already seen", async () => {
    const markMessageSeen = vi.fn(() => true);
    const ctx = buildCtx(markMessageSeen);

    const message: SlackMessageEvent = {
      channel: "C1",
      channel_type: "channel",
      user: "U1",
      text: "<@BOT> hello",
      ts: "1.000",
    } as SlackMessageEvent;

    const prepared = await prepareSlackMessage({
      ctx,
      account,
      message,
      opts: { source: "message" },
    });

    expect(prepared).toBeNull();
    expect(markMessageSeen).toHaveBeenCalledWith("C1", "1.000");
  });
});
