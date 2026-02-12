import { beforeEach, describe, expect, it } from "vitest";
import { telegramPlugin } from "../../../extensions/telegram/src/channel.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { resolveOutboundTarget, resolveSessionDeliveryTarget } from "./targets.js";

describe("resolveOutboundTarget", () => {
  beforeEach(() => {
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "telegram", plugin: telegramPlugin, source: "test" }]),
    );
  });

  it("rejects telegram with missing target", () => {
    const res = resolveOutboundTarget({ channel: "telegram", to: " " });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.message).toContain("Telegram");
    }
  });

  it("rejects webchat delivery", () => {
    const res = resolveOutboundTarget({ channel: "webchat", to: "x" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.message).toContain("WebChat");
    }
  });
});

describe("resolveSessionDeliveryTarget", () => {
  it("derives implicit delivery from the last route", () => {
    const resolved = resolveSessionDeliveryTarget({
      entry: {
        sessionId: "sess-1",
        updatedAt: 1,
        lastChannel: " telegram ",
        lastTo: " 123456 ",
        lastAccountId: " acct-1 ",
      },
      requestedChannel: "last",
    });

    expect(resolved).toEqual({
      channel: "telegram",
      to: "123456",
      accountId: "acct-1",
      threadId: undefined,
      mode: "implicit",
      lastChannel: "telegram",
      lastTo: "123456",
      lastAccountId: "acct-1",
      lastThreadId: undefined,
    });
  });

  it("prefers explicit targets without reusing lastTo", () => {
    const resolved = resolveSessionDeliveryTarget({
      entry: {
        sessionId: "sess-2",
        updatedAt: 1,
        lastChannel: "telegram",
        lastTo: "123456",
      },
      requestedChannel: "slack",
    });

    expect(resolved).toEqual({
      channel: "slack",
      to: undefined,
      accountId: undefined,
      threadId: undefined,
      mode: "implicit",
      lastChannel: "telegram",
      lastTo: "123456",
      lastAccountId: undefined,
      lastThreadId: undefined,
    });
  });

  it("allows mismatched lastTo when configured", () => {
    const resolved = resolveSessionDeliveryTarget({
      entry: {
        sessionId: "sess-3",
        updatedAt: 1,
        lastChannel: "telegram",
        lastTo: "123456",
      },
      requestedChannel: "slack",
      allowMismatchedLastTo: true,
    });

    expect(resolved).toEqual({
      channel: "slack",
      to: "123456",
      accountId: undefined,
      threadId: undefined,
      mode: "implicit",
      lastChannel: "telegram",
      lastTo: "123456",
      lastAccountId: undefined,
      lastThreadId: undefined,
    });
  });

  it("falls back to a provided channel when requested is unsupported", () => {
    const resolved = resolveSessionDeliveryTarget({
      entry: {
        sessionId: "sess-4",
        updatedAt: 1,
        lastChannel: "telegram",
        lastTo: "123456",
      },
      requestedChannel: "webchat",
      fallbackChannel: "slack",
    });

    expect(resolved).toEqual({
      channel: "slack",
      to: undefined,
      accountId: undefined,
      threadId: undefined,
      mode: "implicit",
      lastChannel: "telegram",
      lastTo: "123456",
      lastAccountId: undefined,
      lastThreadId: undefined,
    });
  });
});
