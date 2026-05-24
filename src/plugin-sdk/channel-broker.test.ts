import { describe, expect, it } from "vitest";
import {
  BROKER_PROTOCOL_VERSION,
  buildBrokerConversationTarget,
  createBrokerOutboundRequest,
  createBrokerReceipt,
  normalizeBrokerPlatformId,
  parseBrokerConversationTarget,
} from "./channel-broker.js";

describe("channel-broker SDK", () => {
  it("normalizes provider platform ids for capability and routing keys", () => {
    expect(normalizeBrokerPlatformId(" Telegram ")).toBe("telegram");
    expect(normalizeBrokerPlatformId("Google Chat")).toBe("google-chat");

    expect(() => normalizeBrokerPlatformId("")).toThrow("broker platform id is required");
    expect(() => normalizeBrokerPlatformId("../telegram")).toThrow("invalid broker platform id");
  });

  it("round-trips broker conversation targets without losing thread scope", () => {
    const target = buildBrokerConversationTarget({
      platform: "Telegram",
      conversationId: "chat 123",
      threadId: "topic/a",
    });

    expect(target).toBe("telegram:chat%20123?threadId=topic%2Fa");
    expect(parseBrokerConversationTarget(target)).toEqual({
      platform: "telegram",
      conversationId: "chat 123",
      threadId: "topic/a",
    });
  });

  it("creates a versioned outbound request for provider-owned delivery", () => {
    const request = createBrokerOutboundRequest({
      requestId: "send-1",
      providerId: "acme",
      platform: "Discord",
      accountId: "workspace-a",
      conversation: {
        id: "channel-1",
        type: "channel",
        threadId: "thread-1",
      },
      mode: "final",
      payloads: [{ text: "hello", channelData: { discord: { suppressEmbeds: true } } }],
      relation: { replyToId: "native-parent", silent: false },
      requirements: { text: true, thread: true, replyTo: true },
    });

    expect(request).toEqual({
      version: BROKER_PROTOCOL_VERSION,
      requestId: "send-1",
      providerId: "acme",
      platform: "discord",
      accountId: "workspace-a",
      conversation: {
        id: "channel-1",
        type: "channel",
        threadId: "thread-1",
      },
      mode: "final",
      payloads: [{ text: "hello", channelData: { discord: { suppressEmbeds: true } } }],
      relation: { replyToId: "native-parent", silent: false },
      requirements: { text: true, thread: true, replyTo: true },
    });
  });

  it("creates versioned receipts with normalized platform ids", () => {
    expect(
      createBrokerReceipt({
        requestId: "send-1",
        providerId: "acme",
        platform: "Slack",
        status: "sent",
        messageIds: ["1716500000.000100"],
        editToken: "1716500000.000100",
      }),
    ).toEqual({
      version: BROKER_PROTOCOL_VERSION,
      requestId: "send-1",
      providerId: "acme",
      platform: "slack",
      status: "sent",
      messageIds: ["1716500000.000100"],
      editToken: "1716500000.000100",
    });
  });
});
