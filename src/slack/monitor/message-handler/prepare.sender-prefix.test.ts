import { describe, expect, it, vi } from "vitest";

import type { SlackMonitorContext } from "../context.js";
import { prepareSlackMessage } from "./prepare.js";

describe("prepareSlackMessage sender prefix", () => {
  it("prefixes channel bodies with sender label", async () => {
    const ctx = {
      cfg: {
        agents: { defaults: { model: "anthropic/claude-opus-4-5", workspace: "/tmp/clawd" } },
        channels: { slack: {} },
      },
      accountId: "default",
      botToken: "xoxb",
      app: { client: {} },
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
        exit: (code: number): never => {
          throw new Error(`exit ${code}`);
        },
      },
      botUserId: "BOT",
      teamId: "T1",
      apiAppId: "A1",
      historyLimit: 0,
      channelHistories: new Map(),
      sessionScope: "per-sender",
      mainKey: "agent:main:main",
      dmEnabled: true,
      dmPolicy: "open",
      allowFrom: [],
      groupDmEnabled: false,
      groupDmChannels: [],
      defaultRequireMention: true,
      groupPolicy: "open",
      useAccessGroups: false,
      reactionMode: "off",
      reactionAllowlist: [],
      replyToMode: "off",
      threadHistoryScope: "channel",
      threadInheritParent: false,
      slashCommand: { command: "/clawd", enabled: true },
      textLimit: 2000,
      ackReactionScope: "off",
      mediaMaxBytes: 1000,
      removeAckAfterReply: false,
      logger: { info: vi.fn() },
      markMessageSeen: () => false,
      shouldDropMismatchedSlackEvent: () => false,
      resolveSlackSystemEventSessionKey: () => "agent:main:slack:channel:C1",
      isChannelAllowed: () => true,
      resolveChannelName: async () => ({
        name: "general",
        type: "channel",
      }),
      resolveUserName: async () => ({ name: "Alice" }),
      setSlackThreadStatus: async () => undefined,
    } satisfies SlackMonitorContext;

    const result = await prepareSlackMessage({
      ctx,
      account: { accountId: "default", config: {} } as never,
      message: {
        type: "message",
        channel: "C1",
        channel_type: "channel",
        text: "<@BOT> hello",
        user: "U1",
        ts: "1700000000.0001",
        event_ts: "1700000000.0001",
      } as never,
      opts: { source: "message", wasMentioned: true },
    });

    expect(result).not.toBeNull();
    const body = result?.ctxPayload.Body ?? "";
    expect(body).toContain("Alice (U1): <@BOT> hello");
  });
});
