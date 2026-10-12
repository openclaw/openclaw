/** Tests completion delivery policy for source replies and private finals. */
import { describe, expect, it } from "vitest";
import {
  completionRequiresMessageToolDelivery,
  resolveDurableCompletionDeliveryMode,
} from "./completion-delivery-policy.js";

const chatTypeProbeConfig = {
  messages: {
    visibleReplies: "message_tool",
    groupChat: { visibleReplies: "automatic" },
  },
} as const;

describe("completion delivery policy", () => {
  it("prefers explicit session chat type over key inference", () => {
    expect(
      completionRequiresMessageToolDelivery({
        cfg: chatTypeProbeConfig,
        requesterSessionKey: "agent:main:slack:channel:C123",
        requesterEntry: { chatType: "direct" },
      }),
    ).toBe(true);
  });

  it.each([{ to: "thread:171.222" }] as const)(
    "falls back to origin target prefix $to",
    ({ to }) => {
      expect(
        completionRequiresMessageToolDelivery({
          cfg: chatTypeProbeConfig,
          requesterSessionKey: "agent:main:opaque:unknown-target",
          directOrigin: { channel: "test", to },
        }),
      ).toBe(false);
    },
  );

  it("allows automatic delivery for group and channel completions by default", () => {
    expect(
      completionRequiresMessageToolDelivery({
        cfg: {},
        requesterSessionKey: "agent:main:whatsapp:123@g.us",
      }),
    ).toBe(false);
    expect(
      completionRequiresMessageToolDelivery({
        cfg: {},
        requesterSessionKey: "agent:main:discord:guild-123:channel-456",
      }),
    ).toBe(false);
  });

  it("requires message-tool delivery for direct completions only when globally configured", () => {
    expect(
      completionRequiresMessageToolDelivery({
        cfg: {},
        requesterSessionKey: "agent:main:discord:dm:U123",
      }),
    ).toBe(false);
    expect(
      completionRequiresMessageToolDelivery({
        cfg: { messages: { visibleReplies: "message_tool" } },
        requesterSessionKey: "agent:main:discord:dm:U123",
      }),
    ).toBe(true);
  });

  it("uses host-owned explicit delivery for durable completions under message-tool policy", () => {
    expect(resolveDurableCompletionDeliveryMode("message_tool_only")).toBe("host_owned");
    expect(resolveDurableCompletionDeliveryMode("automatic")).toBe("automatic");
  });
});
