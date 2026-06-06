// Tests pending final delivery records and deferred message-tool send behavior.
import { describe, expect, it } from "vitest";
import {
  INTERNAL_RUNTIME_CONTEXT_BEGIN,
  INTERNAL_RUNTIME_CONTEXT_END,
} from "../../agents/internal-runtime-context.js";
import {
  isSameRoutePendingFinalDeliveryReplaySafe,
  resolveSlackDirectPendingFinalDeliveryContext,
  sanitizePendingFinalDeliveryText,
} from "./pending-final-delivery.js";

describe("sanitizePendingFinalDeliveryText", () => {
  it("strips internal metadata from durable pending delivery text", () => {
    const text = [
      "Visible reply",
      INTERNAL_RUNTIME_CONTEXT_BEGIN,
      "internal detail",
      INTERNAL_RUNTIME_CONTEXT_END,
      "",
      "Conversation info (untrusted metadata):",
      "```json",
      '{"message_id":"msg-1"}',
      "```",
    ].join("\n");

    expect(sanitizePendingFinalDeliveryText(text)).toBe("Visible reply");
  });

  it("drops silent reply sentinel payloads", () => {
    expect(sanitizePendingFinalDeliveryText(" NO_REPLY ")).toBe("");
    expect(sanitizePendingFinalDeliveryText('{"action":"NO_REPLY"}')).toBe("");
  });

  it("strips mixed silent reply sentinels like normal delivery", () => {
    expect(sanitizePendingFinalDeliveryText("NO_REPLYThe user is saying hello")).toBe(
      "The user is saying hello",
    );
    expect(sanitizePendingFinalDeliveryText("HEARTBEAT_OK NO_REPLY")).toBe("HEARTBEAT_OK");
  });

  it("preserves heartbeat ack text for ack-aware classification", () => {
    expect(sanitizePendingFinalDeliveryText("HEARTBEAT_OK short")).toBe("HEARTBEAT_OK short");
  });
});

describe("isSameRoutePendingFinalDeliveryReplaySafe", () => {
  it("allows replay only when channel, target, account, and thread match", () => {
    expect(
      isSameRoutePendingFinalDeliveryReplaySafe({
        pendingContext: {
          channel: "slack",
          to: "D123",
          accountId: "son-of-anton",
          threadId: "1780719008.053929",
        },
        currentContext: {
          channel: "SLACK",
          to: "D123",
          accountId: "son-of-anton",
          threadId: "1780719008.053929",
        },
      }),
    ).toBe(true);
  });

  it("blocks replay when the saved route lacks exact destination proof", () => {
    expect(
      isSameRoutePendingFinalDeliveryReplaySafe({
        pendingContext: { channel: "slack", to: "D123" },
        currentContext: { channel: "slack", to: "D123", accountId: "son-of-anton" },
      }),
    ).toBe(false);
    expect(
      isSameRoutePendingFinalDeliveryReplaySafe({
        pendingContext: { channel: "slack", to: "D123", accountId: "son-of-anton" },
        currentContext: {
          channel: "slack",
          to: "D123",
          accountId: "son-of-anton",
          threadId: "1780719008.053929",
        },
      }),
    ).toBe(false);
  });

  it("blocks replay to a different channel target", () => {
    expect(
      isSameRoutePendingFinalDeliveryReplaySafe({
        pendingContext: { channel: "slack", to: "D123", accountId: "son-of-anton" },
        currentContext: { channel: "telegram", to: "D123", accountId: "son-of-anton" },
      }),
    ).toBe(false);
    expect(
      isSameRoutePendingFinalDeliveryReplaySafe({
        pendingContext: { channel: "slack", to: "D123", accountId: "son-of-anton" },
        currentContext: { channel: "slack", to: "D999", accountId: "son-of-anton" },
      }),
    ).toBe(false);
  });
});

describe("resolveSlackDirectPendingFinalDeliveryContext", () => {
  it("uses the concrete Slack DM channel for direct user-scoped pending targets", () => {
    expect(
      resolveSlackDirectPendingFinalDeliveryContext({
        context: {
          channel: "slack",
          to: "user:U039P2YJR29",
          accountId: "son-of-anton",
          threadId: "1780718204.607",
        },
        nativeChannelId: "D0ACL8LRTJP",
        chatType: "direct",
        directUserTarget: "user:U039P2YJR29",
      }),
    ).toEqual({
      channel: "slack",
      to: "channel:D0ACL8LRTJP",
      accountId: "son-of-anton",
      threadId: "1780718204.607",
    });
  });

  it("does not rewrite Slack DM targets when the proven user differs", () => {
    expect(
      resolveSlackDirectPendingFinalDeliveryContext({
        context: {
          channel: "slack",
          to: "user:U039P2YJR29",
          accountId: "son-of-anton",
        },
        nativeChannelId: "D0ACL8LRTJP",
        chatType: "direct",
        directUserTarget: "user:UOTHER",
      }),
    ).toEqual({
      channel: "slack",
      to: "user:U039P2YJR29",
      accountId: "son-of-anton",
    });
  });

  it("leaves non-Slack and non-direct targets unchanged", () => {
    expect(
      resolveSlackDirectPendingFinalDeliveryContext({
        context: { channel: "discord", to: "user:U039P2YJR29" },
        nativeChannelId: "D0ACL8LRTJP",
        chatType: "direct",
      }),
    ).toEqual({ channel: "discord", to: "user:U039P2YJR29", accountId: undefined });
    expect(
      resolveSlackDirectPendingFinalDeliveryContext({
        context: { channel: "slack", to: "user:U039P2YJR29" },
        nativeChannelId: "D0ACL8LRTJP",
        chatType: "group",
      }),
    ).toEqual({ channel: "slack", to: "user:U039P2YJR29", accountId: undefined });
  });
});
