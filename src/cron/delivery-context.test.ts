// Cron delivery context tests cover context assembly for scheduled job delivery.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";

const { extractDeliveryInfoMock } = vi.hoisted(() => ({
  extractDeliveryInfoMock: vi.fn(),
}));

vi.mock("../config/sessions/delivery-info.js", () => ({
  extractDeliveryInfo: extractDeliveryInfoMock,
}));

import { resolveCronCreationDelivery } from "./delivery-context.js";

describe("cron delivery context", () => {
  const cfg = {} as OpenClawConfig;

  beforeEach(() => {
    extractDeliveryInfoMock.mockReset();
    extractDeliveryInfoMock.mockReturnValue({ deliveryContext: undefined, threadId: undefined });
  });

  it("builds announce delivery from deliveryContext without changing target casing", () => {
    expect(
      resolveCronCreationDelivery({
        cfg,
        currentDeliveryContext: {
          channel: " Matrix ",
          to: "  !AbCdEf1234567890:Example.Org  ",
          accountId: " Bot-A ",
          threadId: "  $RootEvent:Example.Org  ",
        },
      }),
    ).toEqual({
      mode: "announce",
      channel: "matrix",
      to: "!AbCdEf1234567890:Example.Org",
      accountId: "bot-a",
      threadId: "$RootEvent:Example.Org",
    });
  });

  it("prefers current deliveryContext over stored session deliveryContext", () => {
    extractDeliveryInfoMock.mockReturnValueOnce({
      deliveryContext: { channel: "matrix", to: "!stored:example.org" },
      threadId: undefined,
    });

    expect(
      resolveCronCreationDelivery({
        cfg,
        agentSessionKey: "agent:main:matrix:channel:!stored:example.org",
        currentDeliveryContext: {
          channel: "matrix",
          to: "!Current:Example.Org",
        },
      }),
    ).toEqual({
      mode: "announce",
      channel: "matrix",
      to: "!Current:Example.Org",
    });
    expect(extractDeliveryInfoMock).not.toHaveBeenCalled();
  });

  it("uses stored session deliveryContext when current context is absent", () => {
    extractDeliveryInfoMock.mockReturnValueOnce({
      deliveryContext: {
        channel: "line",
        to: "Cabcdef0123456789abcdef0123456789",
        accountId: "primary",
      },
      threadId: undefined,
    });

    expect(
      resolveCronCreationDelivery({
        cfg,
        agentSessionKey: "agent:main:line:group:cabcdef0123456789abcdef0123456789",
      }),
    ).toEqual({
      mode: "announce",
      channel: "line",
      to: "Cabcdef0123456789abcdef0123456789",
      accountId: "primary",
    });
  });

  it("preserves parsed thread ids from stored session lookups", () => {
    extractDeliveryInfoMock.mockReturnValueOnce({
      deliveryContext: {
        channel: "telegram",
        to: "-1001234567890",
        threadId: "stale-topic",
      },
      threadId: "99",
    });

    expect(
      resolveCronCreationDelivery({
        cfg,
        agentSessionKey: "agent:main:telegram:group:-1001234567890:topic:99",
      }),
    ).toEqual({
      mode: "announce",
      channel: "telegram",
      to: "-1001234567890",
      threadId: "99",
    });
  });

  it("does not create delivery without a concrete target", () => {
    expect(
      resolveCronCreationDelivery({
        cfg,
        currentDeliveryContext: { channel: "matrix", to: "   " },
      }),
    ).toBeNull();
    expect(
      resolveCronCreationDelivery({
        cfg,
        agentSessionKey: "agent:main:matrix:channel:!abcdef:example.org",
      }),
    ).toBeNull();
  });

  it.each(["webchat", " WebChat ", "heartbeat", "cron", "webhook", "voice", "sessions_send"])(
    "does not turn internal %s context into an external announce route",
    (channel) => {
      expect(
        resolveCronCreationDelivery({
          cfg,
          currentDeliveryContext: {
            channel,
            to: "agent:main:dashboard:conversation",
            accountId: "internal-account",
            threadId: "internal-thread",
          },
        }),
      ).toBeNull();
    },
  );

  it("does not copy a stored internal route into announce delivery", () => {
    extractDeliveryInfoMock.mockReturnValueOnce({
      deliveryContext: { channel: "webchat", to: "agent:main:dashboard:conversation" },
      threadId: undefined,
    });
    expect(
      resolveCronCreationDelivery({ cfg, agentSessionKey: "agent:main:dashboard:conversation" }),
    ).toBeNull();
  });

  it.each(["agent:main:dashboard:conversation", undefined])(
    "does not replace live internal context with a stored external route (to: %s)",
    (to) => {
      extractDeliveryInfoMock.mockReturnValueOnce({
        deliveryContext: { channel: "discord", to: "channel:stored" },
        threadId: undefined,
      });
      expect(
        resolveCronCreationDelivery({
          cfg,
          agentSessionKey: "agent:main:dashboard:conversation",
          currentDeliveryContext: { channel: " WebChat ", to },
        }),
      ).toBeNull();
      expect(extractDeliveryInfoMock).not.toHaveBeenCalled();
    },
  );

  it("preserves custom external channels for Gateway-owned validation", () => {
    expect(
      resolveCronCreationDelivery({
        cfg,
        currentDeliveryContext: { channel: "custom-plugin", to: "CaseSensitiveRecipient" },
      }),
    ).toEqual({ mode: "announce", channel: "custom-plugin", to: "CaseSensitiveRecipient" });
  });
});
