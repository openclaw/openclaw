import { describe, expect, it, vi } from "vitest";
import { normalizeMessageActionInput } from "./message-action-normalization.js";

vi.mock("../../channels/plugins/bootstrap-registry.js", async () => ({
  getBootstrapChannelPlugin: (
    await import("./message-action-test-fixtures.js")
  ).createPinboardMessageActionBootstrapRegistryMock(),
}));

vi.mock("../../utils/message-channel.js", () => ({
  isDeliverableMessageChannel: (value: string) => ["workspace", "forum"].includes(value),
  normalizeMessageChannel: (value?: string | null) =>
    typeof value === "string" ? value.trim().toLowerCase() : undefined,
}));

describe("normalizeMessageActionInput", () => {
  type NormalizeMessageActionInputCase = {
    input: Parameters<typeof normalizeMessageActionInput>[0];
    expectedFields?: Record<string, unknown>;
    absentFields?: string[];
  };

  it.each([
    {
      input: {
        action: "send",
        args: {
          target: "channel:C1",
          to: "legacy",
          channelId: "legacy-channel",
        },
      },
      expectedFields: { target: "channel:C1", to: "channel:C1" },
      absentFields: ["channelId"],
    },
    {
      input: {
        action: "send",
        args: {
          target: "1214056829",
          channelId: "",
          to: "   ",
        },
      },
      expectedFields: { target: "1214056829", to: "1214056829" },
      absentFields: ["channelId"],
    },
    {
      input: {
        action: "send",
        args: {
          to: "channel:C1",
        },
      },
      expectedFields: { target: "channel:C1", to: "channel:C1" },
    },
    {
      input: {
        action: "send",
        args: {},
        toolContext: {
          currentChannelId: "channel:C1",
        },
      },
      expectedFields: { target: "channel:C1", to: "channel:C1" },
    },
    {
      input: {
        action: "send",
        args: {
          target: "channel:C1",
        },
        toolContext: {
          currentChannelId: "C1",
          currentChannelProvider: "workspace",
        },
      },
      expectedFields: { channel: "workspace" },
    },
    {
      input: {
        action: "broadcast",
        args: {},
        toolContext: {
          currentChannelId: "channel:C1",
        },
      },
      absentFields: ["target", "to"],
    },
    {
      input: {
        action: "send",
        args: {
          target: "channel:C1",
        },
        toolContext: {
          currentChannelProvider: "webchat",
        },
      },
      absentFields: ["channel"],
    },
    {
      input: {
        action: "edit",
        args: {
          messageId: "msg_123",
        },
        toolContext: {
          currentChannelId: "channel:C1",
        },
      },
      expectedFields: { messageId: "msg_123" },
      absentFields: ["target", "to"],
    },
    {
      input: {
        action: "pin",
        args: {
          channel: "pinboard",
          messageId: "om_123",
        },
      },
      expectedFields: { messageId: "om_123" },
      absentFields: ["target", "to"],
    },
    {
      input: {
        action: "list-pins",
        args: {
          channel: "pinboard",
          chatId: "oc_123",
        },
      },
      expectedFields: { chatId: "oc_123" },
      absentFields: ["target", "to"],
    },
    {
      input: {
        action: "read",
        args: {
          channel: "workspace",
          messageId: "123.456",
        },
        toolContext: {
          currentChannelId: "C12345678",
          currentChannelProvider: "workspace",
        },
      },
      expectedFields: { target: "C12345678", messageId: "123.456" },
    },
    {
      input: {
        action: "channel-info",
        args: {
          channelId: "C123",
        },
      },
      expectedFields: { target: "C123", channelId: "C123" },
      absentFields: ["to"],
    },
    {
      input: {
        action: "channel-info",
        args: {
          channelId: "1507887702379335791",
        },
      },
      expectedFields: {
        target: "1507887702379335791",
        channelId: "1507887702379335791",
      },
      absentFields: ["to"],
    },
    {
      input: {
        action: "read",
        args: {
          channel: "discord",
          channelId: "1507887702379335791",
          limit: 50,
        },
      },
      expectedFields: {
        target: "channel:1507887702379335791",
        to: "channel:1507887702379335791",
        limit: 50,
      },
      absentFields: ["channelId"],
    },
    {
      input: {
        action: "read",
        args: {
          channel: "discord",
          channelId: "1507887702379335791",
        },
        toolContext: {
          currentChannelProvider: "telegram",
        },
      },
      expectedFields: {
        target: "channel:1507887702379335791",
        to: "channel:1507887702379335791",
      },
      absentFields: ["channelId"],
    },
    {
      input: {
        action: "read",
        args: {
          channelId: "1507887702379335791",
        },
        toolContext: {
          currentChannelProvider: "discord",
        },
      },
      expectedFields: {
        target: "channel:1507887702379335791",
        to: "channel:1507887702379335791",
      },
      absentFields: ["channelId"],
    },
    {
      input: {
        action: "read",
        args: {
          channel: "discord",
          channelId: "channel:1507887702379335791",
          limit: 50,
        },
      },
      expectedFields: {
        target: "channel:1507887702379335791",
        to: "channel:1507887702379335791",
        limit: 50,
      },
      absentFields: ["channelId"],
    },
    {
      input: {
        action: "read",
        args: {
          channel: "discord",
          channelId: "discord:channel:1507887702379335791",
        },
      },
      expectedFields: {
        target: "discord:channel:1507887702379335791",
        to: "discord:channel:1507887702379335791",
      },
      absentFields: ["channelId"],
    },
    {
      input: {
        action: "read",
        args: {
          channel: "discord",
          channelId: "group:1507887702379335791",
        },
      },
      expectedFields: {
        target: "group:1507887702379335791",
        to: "group:1507887702379335791",
      },
      absentFields: ["channelId"],
    },
    {
      input: {
        action: "read",
        args: {
          channel: "telegram",
          channelId: "-1001234567890:topic:77",
          limit: 20,
        },
      },
      expectedFields: {
        target: "-1001234567890:topic:77",
        to: "-1001234567890:topic:77",
        limit: 20,
      },
      absentFields: ["channelId"],
    },
    {
      input: {
        action: "send",
        args: {
          channel: "telegram",
          channelId: "group:-1001234567890:topic:77",
          text: "hello",
        },
      },
      expectedFields: {
        target: "group:-1001234567890:topic:77",
        to: "group:-1001234567890:topic:77",
        text: "hello",
      },
      absentFields: ["channelId"],
    },
  ] satisfies NormalizeMessageActionInputCase[])(
    "normalizes message action input for %j",
    ({ input, expectedFields, absentFields }) => {
      const normalized = normalizeMessageActionInput(input);
      if (expectedFields) {
        for (const [field, value] of Object.entries(expectedFields)) {
          expect(normalized[field]).toBe(value);
        }
      }
      for (const field of absentFields ?? []) {
        expect(field in normalized).toBe(false);
      }
    },
  );

  it("throws when required target remains unresolved", () => {
    expect(() =>
      normalizeMessageActionInput({
        action: "send",
        args: {},
      }),
    ).toThrow(/requires a target/);
  });
});
