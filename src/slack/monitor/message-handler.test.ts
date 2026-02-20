import type { App } from "@slack/bolt";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../src/config/config.js";
import type { RuntimeEnv } from "../../../src/runtime.js";
import type { SlackMessageEvent } from "../types.js";
import { createSlackMonitorContext } from "./context.js";
import { createSlackMessageHandler } from "./message-handler.js";
import { dispatchPreparedSlackMessage } from "./message-handler/dispatch.js";
import { prepareSlackMessage } from "./message-handler/prepare.js";
import type { PreparedSlackMessage } from "./message-handler/types.js";

vi.mock("./message-handler/prepare.js", () => ({
  prepareSlackMessage: vi.fn(),
}));

vi.mock("./message-handler/dispatch.js", () => ({
  dispatchPreparedSlackMessage: vi.fn(),
}));

const prepareSlackMessageMock = vi.mocked(prepareSlackMessage);
const dispatchPreparedSlackMessageMock = vi.mocked(dispatchPreparedSlackMessage);

describe("slack createSlackMessageHandler", () => {
  function createInboundSlackCtx(params: {
    cfg: OpenClawConfig;
    appClient?: App["client"];
    defaultRequireMention?: boolean;
  }) {
    return createSlackMonitorContext({
      cfg: params.cfg,
      accountId: "default",
      botToken: "token",
      app: { client: params.appClient ?? ({} as App["client"]) } as App,
      runtime: {} as RuntimeEnv,
      botUserId: "B1",
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
      defaultRequireMention: params.defaultRequireMention ?? true,
      channelsConfig: {},
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
  }

  const defaultAccount = {
    accountId: "default",
    enabled: true,
    botTokenSource: "config",
    appTokenSource: "config",
    config: {},
  } as const;

  const basePreparedMessage = {
    route: {
      sessionKey: "session",
      mainSessionKey: "main",
      agentId: "main",
      accountId: "default",
    },
    channelConfig: null,
    isDirectMessage: false,
    isRoomish: true,
    historyKey: "main",
    preview: "",
    ackReactionValue: "ack",
    ackReactionPromise: Promise.resolve(false),
    replyTarget: "C123",
    ctxPayload: {},
  } as unknown as PreparedSlackMessage;

  beforeEach(() => {
    prepareSlackMessageMock.mockReset().mockResolvedValue(basePreparedMessage);
    dispatchPreparedSlackMessageMock.mockReset();
  });

  it("deduplicates message + app_mention using event_ts when ts is missing", async () => {
    const ctx = createInboundSlackCtx({
      cfg: {
        channels: { slack: { enabled: true } },
      } as OpenClawConfig,
    });
    const handler = createSlackMessageHandler({ ctx, account: defaultAccount });
    const sharedTs = "1700000000.000";
    const baseMessage = {
      channel: "C123",
      channel_type: "channel",
      user: "U123",
      text: "<@B1> hello",
      ts: sharedTs,
      event_ts: sharedTs,
      type: "message",
    } as SlackMessageEvent;

    const slackMessage = { ...baseMessage };
    const slackMention = {
      ...baseMessage,
      type: "app_mention",
      ts: undefined,
      event_ts: sharedTs,
    } as unknown as SlackMessageEvent;

    await handler(slackMessage, { source: "message" });
    await handler(slackMention, { source: "app_mention", wasMentioned: true });

    expect(prepareSlackMessageMock).toHaveBeenCalledTimes(1);
    expect(dispatchPreparedSlackMessageMock).toHaveBeenCalledTimes(1);
  });
});
