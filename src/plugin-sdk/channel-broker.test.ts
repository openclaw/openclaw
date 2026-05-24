import { describe, expect, it } from "vitest";
import {
  BROKER_PROTOCOL_VERSION,
  brokerPlatformSupports,
  buildBrokerInboundDedupeKey,
  buildBrokerConversationTarget,
  createBrokerInboundEvent,
  createBrokerOutboundRequest,
  createBrokerReceipt,
  normalizeBrokerKnownPlatformId,
  normalizeBrokerPlatformId,
  normalizeBrokerInboundEvent,
  resolveBrokerPlatformCapabilities,
  parseBrokerConversationTarget,
} from "./channel-broker.js";
import type { BrokerProviderCapabilities } from "./channel-broker.js";

describe("channel-broker SDK", () => {
  it("normalizes provider platform ids for capability and routing keys", () => {
    expect(normalizeBrokerPlatformId(" Telegram ")).toBe("telegram");
    expect(normalizeBrokerPlatformId("Google Chat")).toBe("google-chat");

    expect(() => normalizeBrokerPlatformId("")).toThrow("broker platform id is required");
    expect(() => normalizeBrokerPlatformId("../telegram")).toThrow("invalid broker platform id");
  });

  it("normalizes known broker platform aliases without closing provider-owned ids", () => {
    expect(normalizeBrokerKnownPlatformId("Teams")).toBe("microsoft-teams");
    expect(normalizeBrokerKnownPlatformId("msteams")).toBe("microsoft-teams");
    expect(normalizeBrokerKnownPlatformId("Google Chat")).toBe("google-chat");
    expect(normalizeBrokerKnownPlatformId("googlechat")).toBe("google-chat");
    expect(normalizeBrokerKnownPlatformId("qq")).toBe("qqbot");
    expect(normalizeBrokerKnownPlatformId("custom-regional-chat")).toBe("custom-regional-chat");
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

  it("normalizes inbound events without losing provider-native metadata", () => {
    const event = createBrokerInboundEvent({
      eventId: " evt-1 ",
      providerId: " acme ",
      platform: "Telegram",
      accountId: " bot-main ",
      conversation: {
        id: " -100123 ",
        type: "thread",
        parentId: " -100123 ",
        threadId: " 77 ",
        title: " Ops ",
      },
      sender: {
        id: " user-1 ",
        handle: " lume ",
        displayName: " Lume ",
        raw: { native: "sender" },
      },
      message: {
        id: " msg-1 ",
        text: " hello ",
        attachments: [
          {
            id: " file-1 ",
            mediaType: " image ",
            mimeType: " image/png ",
            url: " https://cdn.example.test/file.png ",
          },
        ],
        nativeIds: { " telegram.message_id ": " 123 ", empty: " " },
        rawRef: " update-1 ",
        raw: { update_id: 99 },
      },
      capabilities: {
        providerId: " acme ",
        delivery: { text: true },
        platforms: [{ platform: "Telegram", delivery: { thread: true } }],
      },
      raw: { update_id: 99 },
    });

    expect(event).toMatchObject({
      version: BROKER_PROTOCOL_VERSION,
      eventId: "evt-1",
      providerId: "acme",
      platform: "telegram",
      accountId: "bot-main",
      conversation: {
        id: "-100123",
        type: "thread",
        parentId: "-100123",
        threadId: "77",
        title: "Ops",
      },
      sender: {
        id: "user-1",
        handle: "lume",
        displayName: "Lume",
        raw: { native: "sender" },
      },
      message: {
        id: "msg-1",
        text: "hello",
        attachments: [
          {
            id: "file-1",
            mediaType: "image",
            mimeType: "image/png",
            url: "https://cdn.example.test/file.png",
          },
        ],
        nativeIds: { "telegram.message_id": "123" },
        rawRef: "update-1",
        raw: { update_id: 99 },
      },
      capabilities: {
        providerId: "acme",
        delivery: { text: true },
        platforms: [{ platform: "telegram", delivery: { thread: true } }],
      },
      raw: { update_id: 99 },
    });
    expect(buildBrokerInboundDedupeKey(event)).toBe("acme:bot-main:telegram:evt-1");
  });

  it("rejects malformed inbound events before durable receive dispatch", () => {
    expect(() =>
      normalizeBrokerInboundEvent({
        version: 2,
        eventId: "evt-1",
        providerId: "acme",
        platform: "telegram",
        conversation: { id: "chat-1", type: "channel" },
        sender: { id: "user-1" },
        message: { id: "msg-1" },
      } as never),
    ).toThrow("unsupported broker inbound event version: 2");
    expect(() =>
      createBrokerInboundEvent({
        eventId: " ",
        providerId: "acme",
        platform: "telegram",
        conversation: { id: "chat-1", type: "channel" },
        sender: { id: "user-1" },
        message: { id: "msg-1" },
      }),
    ).toThrow("broker inbound event id is required");
  });

  it("merges provider-wide and platform-specific capability badges", () => {
    const capabilities: BrokerProviderCapabilities = {
      providerId: "acme",
      delivery: {
        text: true,
        thread: true,
      },
      live: {
        draftPreview: true,
      },
      receive: {
        webhook: true,
      },
      constraints: {
        providerHosted: true,
      },
      badges: ["provider-hosted", " provider-hosted "],
      platforms: [
        {
          platform: "Slack",
          delivery: { replyTo: true },
          live: { progressUpdates: true, previewFinalization: true },
          receive: { ackAfterDurableSend: true },
          constraints: { businessApi: true },
          badges: ["workspace"],
          native: { enterpriseGrid: true },
        },
        {
          platform: "Signal",
          delivery: { text: true, thread: false },
          constraints: { deviceBound: true, selfHosted: true },
          badges: ["device-bound"],
          native: { signalCli: true },
        },
      ],
    };

    expect(resolveBrokerPlatformCapabilities({ capabilities, platform: "slack" })).toEqual({
      platform: "slack",
      delivery: { text: true, thread: true, replyTo: true },
      live: { draftPreview: true, progressUpdates: true, previewFinalization: true },
      receive: { webhook: true, ackAfterDurableSend: true },
      constraints: { providerHosted: true, businessApi: true },
      badges: ["provider-hosted", "workspace"],
      native: { enterpriseGrid: true },
    });
    expect(
      brokerPlatformSupports({
        capabilities,
        platform: "slack",
        requirements: {
          delivery: { text: true, thread: true, replyTo: true },
          live: { previewFinalization: true },
          receive: { webhook: true },
          constraints: { businessApi: true, providerHosted: true },
          native: { enterpriseGrid: true },
        },
      }),
    ).toBe(true);
    expect(
      brokerPlatformSupports({
        capabilities,
        platform: "signal",
        requirements: {
          delivery: { text: true },
          constraints: { deviceBound: true, selfHosted: true },
          native: { signalCli: true },
        },
      }),
    ).toBe(true);
    expect(
      brokerPlatformSupports({
        capabilities,
        platform: "signal",
        requirements: { delivery: { thread: true } },
      }),
    ).toBe(false);
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
