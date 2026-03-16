import { describe, expect, it } from "vitest";
import type { ResolvedSlackAccount } from "../../../../extensions/slack/src/accounts.js";
import { prepareSlackMessage } from "../../../../extensions/slack/src/monitor/message-handler/prepare.js";
import { createInboundSlackTestContext } from "../../../../extensions/slack/src/monitor/message-handler/prepare.test-helpers.js";
import type { SlackMessageEvent } from "../../../../extensions/slack/src/types.js";
import type { OpenClawConfig } from "../../../config/config.js";
import { expectChannelInboundContextContract } from "./suites.js";

function createSlackAccount(config: ResolvedSlackAccount["config"] = {}): ResolvedSlackAccount {
  return {
    accountId: "default",
    enabled: true,
    botTokenSource: "config",
    appTokenSource: "config",
    userTokenSource: "none",
    config,
    replyToMode: config.replyToMode,
    replyToModeByChatType: config.replyToModeByChatType,
    dm: config.dm,
  };
}

function createSlackMessage(overrides: Partial<SlackMessageEvent>): SlackMessageEvent {
  return {
    channel: "D123",
    channel_type: "im",
    user: "U1",
    text: "hi",
    ts: "1.000",
    ...overrides,
  } as SlackMessageEvent;
}

describe("slack inbound contract", () => {
  it("keeps inbound context finalized", async () => {
    const ctx = createInboundSlackTestContext({
      cfg: {
        channels: { slack: { enabled: true } },
      } as OpenClawConfig,
    });
    // oxlint-disable-next-line typescript/no-explicit-any
    ctx.resolveUserName = async () => ({ name: "Alice" }) as any;

    const prepared = await prepareSlackMessage({
      ctx,
      account: createSlackAccount(),
      message: createSlackMessage({}),
      opts: { source: "message" },
    });

    expect(prepared).toBeTruthy();
    expectChannelInboundContextContract(prepared!.ctxPayload);
  });
});
