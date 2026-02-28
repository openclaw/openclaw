import { describe, expect, it } from "vitest";
import {
  resolveOriginAccountId,
  resolveOriginMessageProvider,
  resolveOriginMessageTo,
  resolveRunDeliveryTarget,
} from "./origin-routing.js";

describe("origin-routing helpers", () => {
  it("prefers originating channel over provider for message provider", () => {
    const provider = resolveOriginMessageProvider({
      originatingChannel: "Telegram",
      provider: "heartbeat",
    });

    expect(provider).toBe("telegram");
  });

  it("falls back to provider when originating channel is missing", () => {
    const provider = resolveOriginMessageProvider({
      provider: "  Slack  ",
    });

    expect(provider).toBe("slack");
  });

  it("prefers originating destination over fallback destination", () => {
    const to = resolveOriginMessageTo({
      originatingTo: "channel:C1",
      to: "channel:C2",
    });

    expect(to).toBe("channel:C1");
  });

  it("prefers originating account over fallback account", () => {
    const accountId = resolveOriginAccountId({
      originatingAccountId: "work",
      accountId: "personal",
    });

    expect(accountId).toBe("work");
  });

  it("does not inherit source account/thread ids for read-only relay targets", () => {
    const target = resolveRunDeliveryTarget({
      relayMode: "read-only",
      relayOutput: {
        channel: "telegram",
        to: "telegram:primary",
      },
      originatingAccountId: "imessage-account",
      accountId: "fallback-account",
      originatingThreadId: "imsg-thread",
      threadId: "fallback-thread",
    });

    expect(target).toEqual({
      messageProvider: "telegram",
      messageTo: "telegram:primary",
      accountId: undefined,
      threadId: undefined,
      viaRelayOutput: true,
    });
  });

  it("uses relay account/thread when explicitly configured", () => {
    const target = resolveRunDeliveryTarget({
      relayMode: "read-only",
      relayOutput: {
        channel: "telegram",
        to: "telegram:primary",
        accountId: "telegram-main",
        threadId: 42,
      },
      originatingAccountId: "imessage-account",
      originatingThreadId: "imsg-thread",
    });

    expect(target).toEqual({
      messageProvider: "telegram",
      messageTo: "telegram:primary",
      accountId: "telegram-main",
      threadId: 42,
      viaRelayOutput: true,
    });
  });
});
