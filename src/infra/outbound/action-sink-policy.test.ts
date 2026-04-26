import { describe, expect, it } from "vitest";
import {
  buildMessageActionPolicyRequest,
  buildOutboundDeliveryPolicyRequest,
} from "./action-sink-policy.js";

describe("outbound action-sink policy request builders", () => {
  it("builds message_send requests for ordinary outbound delivery", () => {
    const request = buildOutboundDeliveryPolicyRequest({
      cfg: {} as never,
      channel: "telegram",
      to: "chat-1",
      payloads: [{ text: "hello" }],
      session: { key: "session-1", agentId: "agent-1" },
    });

    expect(request.actionType).toBe("message_send");
    expect(request.targetResource).toBe("telegram:chat-1");
    expect(request.actor).toEqual({ id: "agent-1", sessionKey: "session-1" });
  });

  it("classifies outbound completion claims before delivery", () => {
    const request = buildOutboundDeliveryPolicyRequest({
      cfg: {} as never,
      channel: "telegram",
      to: "chat-1",
      payloads: [{ text: "The implementation is done." }],
    });

    expect(request.actionType).toBe("completion_claim");
  });

  it("builds message action policy requests from normalized tool args", () => {
    const request = buildMessageActionPolicyRequest({
      channel: "discord",
      action: "send",
      to: "channel-1",
      accountId: "acct-1",
      args: { message: "ready to ship" },
      sessionKey: "session-1",
      sessionId: "session-id",
      agentId: "agent-1",
      requesterSenderId: "sender-1",
    });

    expect(request.actionType).toBe("completion_claim");
    expect(request.toolName).toBe("message.send");
    expect(request.targetResource).toBe("discord:channel-1");
    expect(request.context).toMatchObject({
      channel: "discord",
      action: "send",
      requesterSenderId: "sender-1",
    });
  });
});
