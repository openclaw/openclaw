import { describe, expect, it } from "vitest";
import {
  beginTelegramInboundTurnDeliveryCorrelation,
  notifyTelegramInboundTurnOutboundSuccess,
} from "./telegram-inbound-turn-delivery.js";

describe("telegram-inbound-turn-delivery", () => {
  it("marks delivered once for matching telegram outbound then clears correlation", () => {
    let n = 0;
    const end = beginTelegramInboundTurnDeliveryCorrelation("sess:z", {
      outboundTo: "999",
      outboundAccountId: "a1",
      markInboundTurnDelivered: () => {
        n += 1;
      },
    });
    notifyTelegramInboundTurnOutboundSuccess({
      sessionKey: "sess:z",
      channelId: "telegram",
      to: "999",
      accountId: "a1",
      success: true,
    });
    expect(n).toBe(1);
    end();
    notifyTelegramInboundTurnOutboundSuccess({
      sessionKey: "sess:z",
      channelId: "telegram",
      to: "999",
      accountId: "a1",
      success: true,
    });
    expect(n).toBe(1);
  });

  it("ignores telegram outbound delivered to another destination", () => {
    let n = 0;
    const end = beginTelegramInboundTurnDeliveryCorrelation("sess:y", {
      outboundTo: "1",
      markInboundTurnDelivered: () => {
        n += 1;
      },
    });
    notifyTelegramInboundTurnOutboundSuccess({
      sessionKey: "sess:y",
      channelId: "telegram",
      to: "2",
      accountId: undefined,
      success: true,
    });
    expect(n).toBe(0);
    end();
  });
});
