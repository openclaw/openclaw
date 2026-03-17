import { describe, expect, it } from "vitest";
import { inboundCtxCapture } from "../../../../test/helpers/inbound-contract-dispatch-mock.js";
import { expectChannelInboundContextContract } from "./suites.js";

const { processDiscordMessage } =
  await import("../../../../extensions/discord/src/monitor/message-handler.process.js");
const { createBaseDiscordMessageContext, createDiscordDirectMessageContextOverrides } =
  await import("../../../../extensions/discord/src/monitor/message-handler.test-harness.js");

describe("discord inbound contract", () => {
  it("keeps inbound context finalized", async () => {
    inboundCtxCapture.ctx = undefined;
    const messageCtx = await createBaseDiscordMessageContext({
      cfg: { messages: {} },
      ackReactionScope: "direct",
      ...createDiscordDirectMessageContextOverrides(),
    });

    await processDiscordMessage(messageCtx);

    expect(inboundCtxCapture.ctx).toBeTruthy();
    expectChannelInboundContextContract(inboundCtxCapture.ctx!);
  });
});
