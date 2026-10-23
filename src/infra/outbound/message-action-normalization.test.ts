import { describe, expect, it, vi } from "vitest";
import { normalizeMessageActionInput } from "./message-action-normalization.js";

vi.mock("../../channels/plugins/bootstrap-registry.js", async () => ({
  getBootstrapChannelPlugin: (
    await import("./message-action-runner.test-support.js")
  ).createPinboardMessageActionBootstrapRegistryMock(),
}));

vi.mock("../../utils/message-channel.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils/message-channel.js")>()),
  isDeliverableMessageChannel: (value: string) => ["workspace", "forum"].includes(value),
  normalizeMessageChannel: (value?: string | null) =>
    typeof value === "string" ? value.trim().toLowerCase() : undefined,
}));

describe("normalizeMessageActionInput", () => {
  const routedThreadContext = {
    currentChannelProvider: "discord",
    currentChatType: "channel" as const,
    currentChannelId: "channel:parent",
    currentMessagingTarget: "channel:thread",
    currentMessageId: "thread",
  };

  it.each(["read", "react", "edit", "delete"] as const)(
    "keeps the native message conversation for an implicit %s",
    (action) => {
      expect(
        normalizeMessageActionInput({
          action,
          args: { channel: "discord", messageId: "thread" },
          toolContext: routedThreadContext,
          targetAliasSpec: { aliases: ["messageId"], deliveryTargetAliases: [] },
        }),
      ).toMatchObject({ target: "channel:parent", to: "channel:parent", messageId: "thread" });
    },
  );

  type Input = Parameters<typeof normalizeMessageActionInput>[0];
  it.each<[Input, Record<string, unknown>, string[]]>([
    [
      { action: "send", args: { target: "channel:C1", to: "legacy", channelId: "legacy-channel" } },
      { target: "channel:C1", to: "channel:C1" },
      ["channelId"],
    ],
    [
      { action: "broadcast", args: {}, toolContext: { currentChannelId: "channel:C1" } },
      {},
      ["target", "to"],
    ],
    [
      {
        action: "unsend",
        args: { channel: "imessage", messageId: "msg_123" },
        toolContext: {
          currentChannelId: "chat_guid:iMessage;+;chat0000",
          currentChannelProvider: "imessage",
        },
      },
      {
        target: "chat_guid:iMessage;+;chat0000",
        to: "chat_guid:iMessage;+;chat0000",
        messageId: "msg_123",
      },
      [],
    ],
    [
      { action: "pin", args: { channel: "pinboard", messageId: "om_123" } },
      { messageId: "om_123" },
      ["target", "to"],
    ],
    [
      { action: "poll-vote", args: { channel: "imessage", chatId: 42 } },
      { target: "chat_id:42", to: "chat_id:42", chatId: 42 },
      [],
    ],
  ])("normalizes message action input for %j", (input, expected, absent) => {
    const normalized = normalizeMessageActionInput(input);
    expect(normalized).toEqual(expect.objectContaining(expected));
    for (const field of absent) {
      expect(field in normalized).toBe(false);
    }
  });
  it.each<[string, Input]>([
    [
      "heartbeat sentinel",
      {
        action: "send",
        args: {},
        toolContext: { currentChannelId: "heartbeat", currentChannelProvider: "telegram" },
      },
    ],
    [
      "internal session",
      {
        action: "send",
        args: { channel: "discord" },
        toolContext: {
          currentChannelId: "channel:agent:main:subagent:worker",
          currentChannelProvider: "discord",
        },
      },
    ],
    [
      "explicit empty targets",
      {
        action: "read",
        args: { targets: [] },
        toolContext: { currentChannelId: "C_CURRENT", currentChannelProvider: "workspace" },
      },
    ],
    [
      "resource without conversation",
      {
        action: "poll-vote",
        args: { channel: "imessage", pollId: "poll_123" },
      },
    ],
  ])("rejects %s as a target", (_name, input) => {
    expect(() => normalizeMessageActionInput(input)).toThrow(/requires a target/);
  });

  it("rejects conflicting canonical and plugin delivery targets", () => {
    expect(() =>
      normalizeMessageActionInput({
        action: "poll-vote",
        args: {
          channel: "imessage",
          target: "chat_guid:iMessage;-;+15550001111",
          chatGuid: "iMessage;-;+15559998888",
        },
      }),
    ).toThrow(/conflicting target and delivery alias/);
  });

  it("allows a trusted direct operator to use an opaque resource without a conversation", () => {
    expect(
      normalizeMessageActionInput({
        action: "unpin",
        args: { channel: "pinboard", postId: "post_123" },
        targetAliasSpec: {
          aliases: ["postId", "roomId"],
          deliveryTargetAliases: ["roomId"],
        },
        allowResourceOnly: true,
      }),
    ).toEqual({ channel: "pinboard", postId: "post_123" });
  });
});
