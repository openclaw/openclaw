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
});

describe("resolveRunDeliveryTarget", () => {
  it("uses relay output for read-only runs", () => {
    const target = resolveRunDeliveryTarget({
      relayMode: "read-only",
      relayOutput: {
        channel: "slack",
        to: "channel:relay",
        accountId: "relay-work",
        threadId: "1739142736.000100",
      },
      originatingChannel: "discord",
      originatingTo: "channel:source",
      originatingAccountId: "source-work",
      originatingThreadId: "1739142736.000200",
    });

    expect(target.viaRelayOutput).toBe(true);
    expect(target.relayMode).toBe("read-only");
    expect(target.channel).toBe("slack");
    expect(target.to).toBe("channel:relay");
    expect(target.accountId).toBe("relay-work");
    expect(target.threadId).toBe("1739142736.000100");
  });

  it("returns no route for read-only runs without relay output", () => {
    const target = resolveRunDeliveryTarget({
      relayMode: "read-only",
      originatingChannel: "discord",
      originatingTo: "channel:source",
    });

    expect(target.relayMode).toBe("read-only");
    expect(target.viaRelayOutput).toBe(false);
    expect(target.channel).toBeUndefined();
    expect(target.to).toBeUndefined();
  });

  it("uses originating route for read-write runs", () => {
    const target = resolveRunDeliveryTarget({
      relayMode: "read-write",
      relayOutput: {
        channel: "slack",
        to: "channel:relay",
      },
      originatingChannel: "discord",
      originatingTo: "channel:source",
      originatingAccountId: "source-work",
      originatingThreadId: "1739142736.000200",
    });

    expect(target.relayMode).toBe("read-write");
    expect(target.viaRelayOutput).toBe(false);
    expect(target.channel).toBe("discord");
    expect(target.to).toBe("channel:source");
    expect(target.accountId).toBe("source-work");
    expect(target.threadId).toBe("1739142736.000200");
  });
});
