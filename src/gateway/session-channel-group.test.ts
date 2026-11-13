import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../config/sessions/types.js";
import { resolveTelegramSessionGroup } from "./session-channel-group.js";

function entry(groupId: string, topic?: string): SessionEntry {
  const target = topic ? `${groupId}:topic:${topic}` : groupId;
  return {
    sessionId: "channel-session",
    updatedAt: 1,
    createdVia: "channel",
    delivery: {
      kind: "external",
      route: {
        channel: "telegram",
        accountId: "default",
        target: { to: `telegram:${target}` },
        ...(topic ? { thread: { id: topic } } : {}),
      },
      context: {},
      origin: { provider: "telegram", chatType: "group", nativeChannelId: target },
    },
  };
}

describe("Telegram session group provenance", () => {
  it.each([
    ["-100123450001", undefined],
    ["-100123450001", "7641"],
    ["-123456", undefined],
    ["-123456", "42"],
  ])("accepts a consistent channel-created group %s topic %s", (groupId, topic) => {
    const suffix = topic ? `:topic:${topic}` : "";
    expect(
      resolveTelegramSessionGroup(
        `agent:main:telegram:group:${groupId}${suffix}`,
        entry(groupId, topic),
      ),
    ).toEqual({
      accountId: "default",
      groupId,
    });
  });

  it("rejects GUI provenance and explicit private ACL even with a Telegram-looking route", () => {
    const key = "agent:main:telegram:group:-123456:topic:42";
    const source = entry("-123456", "42");
    expect(resolveTelegramSessionGroup(key, { ...source, access: { mode: "source" } })).toEqual({
      accountId: "default",
      groupId: "-123456",
    });
    expect(resolveTelegramSessionGroup(key, { ...source, createdVia: "operator" })).toBeUndefined();
    expect(
      resolveTelegramSessionGroup(key, { ...source, access: { mode: "creator" } }),
    ).toBeUndefined();
    expect(resolveTelegramSessionGroup(key, { ...source, visibility: "draft" })).toBeUndefined();
    expect(resolveTelegramSessionGroup(key, { ...source, incognito: true })).toBeUndefined();
  });

  it("rejects direct sessions, missing account, and mismatched groups or topics", () => {
    const source = entry("-123456", "42");
    expect(
      resolveTelegramSessionGroup("agent:main:telegram:direct:123456", source),
    ).toBeUndefined();
    expect(
      resolveTelegramSessionGroup("agent:main:telegram:group:-123456:topic:43", source),
    ).toBeUndefined();
    expect(
      resolveTelegramSessionGroup("agent:main:telegram:group:-987654:topic:42", source),
    ).toBeUndefined();
    if (source.delivery?.kind !== "external") {
      throw new Error("expected external route");
    }
    source.delivery.route.accountId = undefined;
    expect(
      resolveTelegramSessionGroup("agent:main:telegram:group:-123456:topic:42", source),
    ).toBeUndefined();
  });
});
