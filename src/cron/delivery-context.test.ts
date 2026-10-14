import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DeliveryContext } from "../utils/delivery-context.shared.js";
import { resolveCronCreationDelivery } from "./delivery-context.js";

const { extractDeliveryInfoMock } = vi.hoisted(() => ({ extractDeliveryInfoMock: vi.fn() }));
vi.mock("../config/sessions/delivery-info.js", () => ({
  extractDeliveryInfo: extractDeliveryInfoMock,
}));
const sessionKey = "agent:main:dashboard:conversation";
const stored = { channel: "discord", to: "channel:stored" };

describe("cron delivery context", () => {
  beforeEach(() => {
    extractDeliveryInfoMock.mockReset();
  });

  it.each([
    {
      current: {
        channel: " Matrix ",
        to: " !AbCd:Example.Org ",
        accountId: " Bot-A ",
        threadId: " $Root:Example.Org ",
      },
      stored,
      threadId: undefined,
      expected: {
        channel: "matrix",
        to: "!AbCd:Example.Org",
        accountId: "bot-a",
        threadId: "$Root:Example.Org",
      },
    },
    {
      current: undefined,
      stored: { channel: "line", to: "Cabcdef", accountId: "primary" },
      threadId: undefined,
      expected: { channel: "line", to: "Cabcdef", accountId: "primary" },
    },
    {
      current: undefined,
      stored: { channel: "telegram", to: "-1001234567890", threadId: "stale-topic" },
      threadId: "99",
      expected: { channel: "telegram", to: "-1001234567890", threadId: "99" },
    },
    {
      current: { channel: "custom-plugin", to: "CaseSensitiveRecipient" },
      stored,
      threadId: undefined,
      expected: { channel: "custom-plugin", to: "CaseSensitiveRecipient" },
    },
  ])(
    "resolves a concrete route with live context taking precedence %#",
    async ({ current, stored: saved, threadId, expected }) => {
      extractDeliveryInfoMock.mockReturnValueOnce({ deliveryContext: saved, threadId });
      expect(
        await resolveCronCreationDelivery({
          cfg: {},
          agentSessionKey: sessionKey,
          currentDeliveryContext: current,
        }),
      ).toEqual({ mode: "announce", ...expected });
      if (current) {
        expect(extractDeliveryInfoMock).not.toHaveBeenCalled();
      }
    },
  );

  it.each<{
    current?: DeliveryContext;
    stored?: DeliveryContext;
    sessionKey?: string;
    reads: number;
  }>([
    { current: { channel: "matrix", to: "   " }, reads: 0 },
    { sessionKey, reads: 1 },
    { sessionKey, stored: { channel: "webchat", to: sessionKey }, reads: 1 },
    ...[" WebChat ", "cron"].map((channel) => ({
      current: {
        channel,
        to: sessionKey,
        accountId: "internal-account",
        threadId: "internal-thread",
      },
      sessionKey,
      stored,
      reads: 0,
    })),
    { current: { channel: " WebChat " }, sessionKey, stored, reads: 0 },
  ])(
    "does not turn absent or internal context into external delivery %#",
    async ({ current, stored: saved, sessionKey: key, reads }) => {
      extractDeliveryInfoMock.mockReturnValueOnce({ deliveryContext: saved, threadId: undefined });
      expect(
        await resolveCronCreationDelivery({
          cfg: {},
          agentSessionKey: key,
          currentDeliveryContext: current,
        }),
      ).toBeNull();
      expect(extractDeliveryInfoMock).toHaveBeenCalledTimes(reads);
    },
  );
});
