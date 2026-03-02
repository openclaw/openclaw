import { describe, expect, it } from "vitest";
import {
  clearTelegramOutboundSendGuard,
  markTelegramOutboundSendFailure,
  markTelegramOutboundSendSuccess,
  reserveTelegramOutboundSend,
  type TelegramOutboundSendIdentity,
} from "./outbound-send-guard.js";

const baseIdentity: TelegramOutboundSendIdentity = {
  accountId: "default",
  chatId: "123",
  text: "hello world",
};

describe("telegram outbound send guard", () => {
  it("blocks duplicate outbound sends in a short window", () => {
    clearTelegramOutboundSendGuard();
    expect(reserveTelegramOutboundSend(baseIdentity, 1_000)).toEqual({ blocked: false });
    expect(reserveTelegramOutboundSend(baseIdentity, 5_000)).toEqual({
      blocked: true,
      reason: "duplicate",
      retryAfterMs: 4_000,
    });
    expect(reserveTelegramOutboundSend(baseIdentity, 9_001)).toEqual({ blocked: false });
  });

  it("opens a circuit after repeated failures and recovers after cooldown", () => {
    clearTelegramOutboundSendGuard();
    for (let i = 0; i < 5; i += 1) {
      const now = 10_000 + i * 9_000;
      expect(reserveTelegramOutboundSend(baseIdentity, now)).toEqual({ blocked: false });
      markTelegramOutboundSendFailure(baseIdentity, now);
    }

    const blocked = reserveTelegramOutboundSend(baseIdentity, 55_000);
    expect(blocked).toMatchObject({
      blocked: true,
      reason: "circuit_open",
    });
    if (blocked.blocked) {
      expect(blocked.retryAfterMs).toBe(21_000);
    }

    expect(reserveTelegramOutboundSend(baseIdentity, 76_001)).toEqual({ blocked: false });
  });

  it("resets failure streak after a successful send", () => {
    clearTelegramOutboundSendGuard();
    const threadIdentity: TelegramOutboundSendIdentity = {
      ...baseIdentity,
      messageThreadId: 271,
    };

    for (let i = 0; i < 4; i += 1) {
      const now = 100_000 + i * 9_000;
      expect(reserveTelegramOutboundSend(threadIdentity, now)).toEqual({ blocked: false });
      markTelegramOutboundSendFailure(threadIdentity, now);
    }

    const successAt = 140_001;
    expect(reserveTelegramOutboundSend(threadIdentity, successAt)).toEqual({ blocked: false });
    markTelegramOutboundSendSuccess(threadIdentity, successAt);

    for (let i = 0; i < 4; i += 1) {
      const now = 150_000 + i * 9_000;
      expect(reserveTelegramOutboundSend(threadIdentity, now)).toEqual({ blocked: false });
      markTelegramOutboundSendFailure(threadIdentity, now);
    }

    expect(reserveTelegramOutboundSend(threadIdentity, 186_001)).toEqual({ blocked: false });
  });
});
