import { describe, expect, it } from "vitest";
import { sendMessageDiscord } from "../extensions/discord/src/send.outbound.js";
import { createDiscordLoopbackRest } from "../extensions/discord/src/send.test-harness.js";
import {
  attachEmbeddedMessageDeliveryFact,
  projectEmbeddedMessageDeliveryFact,
} from "../src/agents/embedded-agent-message-delivery.js";
import { installMessageToolOnlyTerminalHook } from "../src/agents/embedded-agent-runner/run/message-tool-terminal.js";
import type { AfterToolCallContext, Agent, AgentToolResult } from "../src/agents/runtime/index.js";
import type { MessageActionResult } from "../src/infra/outbound/message-action-contracts.js";

describe("Discord message-tool terminal delivery", () => {
  it("turns an actual Discord REST receipt into a completed source reply", async () => {
    const loopback = await createDiscordLoopbackRest();
    try {
      const sendResult = await sendMessageDiscord("channel:123", "Loopback completed answer", {
        cfg: { channels: { discord: { token: "test-token", groupPolicy: "open" } } },
        accountId: "default",
        rest: loopback.rest,
      });
      const actionResult = {
        kind: "send",
        channel: "discord",
        action: "send",
        to: "channel:123",
        handledBy: "core",
        payload: { ok: true },
        sendResult: {
          channel: "discord",
          to: "channel:123",
          via: "direct",
          mediaUrl: null,
          result: {
            channel: "discord",
            messageId: sendResult.messageId,
            receipt: sendResult.receipt,
          },
        },
        dryRun: false,
      } satisfies MessageActionResult;
      const deliveryFact = projectEmbeddedMessageDeliveryFact(actionResult, true);
      const toolResult = attachEmbeddedMessageDeliveryFact(
        { content: [], details: {} } satisfies AgentToolResult<unknown>,
        deliveryFact,
      );
      const args = { action: "send", message: "Loopback completed answer" };
      const agent = {} as Agent;
      let completed = false;
      installMessageToolOnlyTerminalHook({
        agent,
        sourceReplyDeliveryMode: "message_tool_only",
        onCompletedSourceReply: () => {
          completed = true;
        },
      });

      const hookResult = await agent.afterToolCall?.({
        toolCall: { name: "message", arguments: args },
        args,
        result: toolResult,
        isError: false,
      } as unknown as AfterToolCallContext);

      expect(loopback.requests).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ method: "POST", path: "/v10/channels/123/messages" }),
        ]),
      );
      expect(deliveryFact).toMatchObject({ status: "settled", partialDelivery: false });
      expect(hookResult).toMatchObject({ terminate: true });
      expect(completed).toBe(true);
    } finally {
      await loopback.close();
    }
  });
});
