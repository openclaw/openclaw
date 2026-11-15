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
  type Input = Parameters<typeof normalizeMessageActionInput>[0];
  const makeInput = (
    action: Input["action"],
    args: Input["args"] = {},
    extra: Partial<Input> = {},
  ): Input => ({ action, args, ...extra });
  const context = (currentChannelId: string, currentChannelProvider: string) => ({
    toolContext: { currentChannelId, currentChannelProvider },
  });
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

  it.each<[Input, Record<string, unknown>, string[]]>([
    [makeInput("send", { target: "  channel:C1  " }), { to: "channel:C1" }, []],
    [makeInput("channel-info", { target: "  C123  " }), { channelId: "C123" }, []],
    [
      makeInput("send", { target: "channel:C1", to: "legacy", channelId: "legacy-channel" }),
      { target: "channel:C1", to: "channel:C1" },
      ["channelId"],
    ],
    [
      makeInput("broadcast", {}, { toolContext: { currentChannelId: "channel:C1" } }),
      {},
      ["target", "to"],
    ],
    [
      makeInput(
        "unsend",
        { channel: "imessage", messageId: "msg_123" },
        context("chat_guid:iMessage;+;chat0000", "imessage"),
      ),
      {
        target: "chat_guid:iMessage;+;chat0000",
        to: "chat_guid:iMessage;+;chat0000",
        messageId: "msg_123",
      },
      [],
    ],
    [
      makeInput("pin", { channel: "pinboard", messageId: "om_123" }),
      { messageId: "om_123" },
      ["target", "to"],
    ],
    [
      makeInput("poll-vote", { channel: "imessage", chatId: 42 }),
      { target: "chat_id:42", to: "chat_id:42", chatId: 42 },
      [],
    ],
  ])("normalizes message action input for %j", (input, expected, absent) => {
    const normalized = normalizeMessageActionInput(input);
    expect(normalized).toMatchObject(expected);
    for (const field of absent) {
      expect(field in normalized).toBe(false);
    }
  });
  it.each<[string, Input]>([
    ["blank target", makeInput("send", { target: "   " })],
    ["heartbeat sentinel", makeInput("send", {}, context("heartbeat", "telegram"))],
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
      makeInput("read", { targets: [] }, context("C_CURRENT", "workspace")),
    ],
    [
      "resource without conversation",
      makeInput("poll-vote", { channel: "imessage", pollId: "poll_123" }),
    ],
  ])("rejects %s as a target", (_name, input) => {
    expect(() => normalizeMessageActionInput(input)).toThrow(/requires a target/);
  });

  it.each<[Input, string]>([
    [
      makeInput("broadcast", { to: "legacy" }),
      "Use `target` for actions that accept a destination.",
    ],
    [
      makeInput("broadcast", { target: "channel:C1" }),
      "Action broadcast does not accept a target.",
    ],
  ])("rejects a destination for no-target action %j", (input, message) => {
    expect(() => normalizeMessageActionInput(input)).toThrow(message);
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
