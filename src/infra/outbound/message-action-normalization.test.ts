import { describe, expect, it } from "vitest";
import { normalizeMessageActionInput } from "./message-action-normalization.js";

describe("normalizeMessageActionInput", () => {
  it("prefers explicit target and clears legacy target fields", () => {
    const normalized = normalizeMessageActionInput({
      action: "send",
      args: {
        target: "channel:C1",
        to: "legacy",
        channelId: "legacy-channel",
      },
    });

    expect(normalized.target).toBe("channel:C1");
    expect(normalized.to).toBe("channel:C1");
    expect("channelId" in normalized).toBe(false);
  });

  it("ignores empty-string legacy target fields when explicit target is present", () => {
    const normalized = normalizeMessageActionInput({
      action: "send",
      args: {
        target: "1214056829",
        channelId: "",
        to: "   ",
      },
    });

    expect(normalized.target).toBe("1214056829");
    expect(normalized.to).toBe("1214056829");
    expect("channelId" in normalized).toBe(false);
  });

  it("maps legacy target fields into canonical target", () => {
    const normalized = normalizeMessageActionInput({
      action: "send",
      args: {
        to: "channel:C1",
      },
    });

    expect(normalized.target).toBe("channel:C1");
    expect(normalized.to).toBe("channel:C1");
  });

  it("infers target from tool context when required", () => {
    const normalized = normalizeMessageActionInput({
      action: "send",
      args: {},
      toolContext: {
        currentChannelId: "channel:C1",
      },
    });

    expect(normalized.target).toBe("channel:C1");
    expect(normalized.to).toBe("channel:C1");
  });

  it("infers channel from tool context provider", () => {
    const normalized = normalizeMessageActionInput({
      action: "send",
      args: {
        target: "channel:C1",
      },
      toolContext: {
        currentChannelId: "C1",
        currentChannelProvider: "slack",
      },
    });

    expect(normalized.channel).toBe("slack");
  });

  it("does not infer a target for actions that do not accept one", () => {
    const normalized = normalizeMessageActionInput({
      action: "broadcast",
      args: {},
      toolContext: {
        currentChannelId: "channel:C1",
      },
    });

    expect("target" in normalized).toBe(false);
    expect("to" in normalized).toBe(false);
  });

  it("does not backfill a non-deliverable tool-context channel", () => {
    const normalized = normalizeMessageActionInput({
      action: "send",
      args: {
        target: "channel:C1",
      },
      toolContext: {
        currentChannelProvider: "webchat",
      },
    });

    expect("channel" in normalized).toBe(false);
  });

  it("keeps alias-based targets without inferring the current channel", () => {
    const normalized = normalizeMessageActionInput({
      action: "edit",
      args: {
        messageId: "msg_123",
      },
      toolContext: {
        currentChannelId: "channel:C1",
      },
    });

    expect(normalized.messageId).toBe("msg_123");
    expect("target" in normalized).toBe(false);
    expect("to" in normalized).toBe(false);
  });

  it("keeps Feishu message and chat aliases without forcing canonical targets", () => {
    const pin = normalizeMessageActionInput({
      action: "pin",
      args: {
        messageId: "om_123",
      },
    });
    const listPins = normalizeMessageActionInput({
      action: "list-pins",
      args: {
        chatId: "oc_123",
      },
    });

    expect(pin.messageId).toBe("om_123");
    expect("target" in pin).toBe(false);
    expect("to" in pin).toBe(false);
    expect(listPins.chatId).toBe("oc_123");
    expect("target" in listPins).toBe(false);
    expect("to" in listPins).toBe(false);
  });

  it("maps legacy channelId inputs through canonical target for channel-id actions", () => {
    const normalized = normalizeMessageActionInput({
      action: "channel-info",
      args: {
        channelId: "C123",
      },
    });

    expect(normalized.target).toBe("C123");
    expect(normalized.channelId).toBe("C123");
    expect("to" in normalized).toBe(false);
  });

  it("throws when required target remains unresolved", () => {
    expect(() =>
      normalizeMessageActionInput({
        action: "send",
        args: {},
      }),
    ).toThrow(/requires a target/);
  });
});
