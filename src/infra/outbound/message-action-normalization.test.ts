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

  describe("card-aware text sanitization", () => {
    it("clears message param when card is present on send action", () => {
      const result = normalizeMessageActionInput({
        action: "send",
        args: {
          target: "user:ou_123",
          message: "Daily Report",
          card: { header: { title: { tag: "plain_text", content: "Daily Report" } } },
        },
      });
      expect(result.message).toBeUndefined();
      expect(result._cardNotificationHint).toBe("Daily Report");
      expect(result.card).toBeDefined();
    });

    it("clears text param when card is present on send action", () => {
      const result = normalizeMessageActionInput({
        action: "send",
        args: {
          target: "user:ou_123",
          text: "Alert Title",
          card: { elements: [] },
        },
      });
      expect(result.text).toBeUndefined();
      expect(result._cardNotificationHint).toBe("Alert Title");
    });

    it("preserves message param when no card is present", () => {
      const result = normalizeMessageActionInput({
        action: "send",
        args: {
          target: "user:ou_123",
          message: "Hello world",
        },
      });
      expect(result.message).toBe("Hello world");
      expect(result._cardNotificationHint).toBeUndefined();
    });

    it("does not sanitize for non-send actions", () => {
      const result = normalizeMessageActionInput({
        action: "edit",
        args: {
          messageId: "msg_123",
          message: "Updated text",
          card: { elements: [] },
        },
      });
      expect(result.message).toBe("Updated text");
    });

    it("handles empty message with card gracefully", () => {
      const result = normalizeMessageActionInput({
        action: "send",
        args: {
          target: "user:ou_123",
          message: "",
          card: { elements: [] },
        },
      });
      expect(result._cardNotificationHint).toBeUndefined();
    });

    it("prefers message over text for notification hint", () => {
      const result = normalizeMessageActionInput({
        action: "send",
        args: {
          target: "user:ou_123",
          message: "Primary",
          text: "Secondary",
          card: { elements: [] },
        },
      });
      expect(result._cardNotificationHint).toBe("Primary");
      expect(result.message).toBeUndefined();
      expect(result.text).toBeUndefined();
    });
  });
});
