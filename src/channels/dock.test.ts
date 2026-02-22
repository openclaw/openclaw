import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { getChannelDock } from "./dock.js";

function emptyConfig(): OpenClawConfig {
  return {} as OpenClawConfig;
}

describe("channels dock", () => {
  it("telegram and googlechat threading contexts map thread ids consistently", () => {
    const hasRepliedRef = { value: false };
    const telegramDock = getChannelDock("telegram");
    const googleChatDock = getChannelDock("googlechat");

    const telegramContext = telegramDock?.threading?.buildToolContext?.({
      cfg: emptyConfig(),
      context: { To: " room-1 ", MessageThreadId: 42, ReplyToId: "fallback" },
      hasRepliedRef,
    });
    const googleChatContext = googleChatDock?.threading?.buildToolContext?.({
      cfg: emptyConfig(),
      context: { To: " space-1 ", ReplyToId: "thread-abc" },
      hasRepliedRef,
    });

    expect(telegramContext).toEqual({
      currentChannelId: "room-1",
      currentThreadTs: "42",
      hasRepliedRef,
    });
    expect(googleChatContext).toEqual({
      currentChannelId: "space-1",
      currentThreadTs: "thread-abc",
      hasRepliedRef,
    });
  });

  it("irc resolveDefaultTo matches account id case-insensitively", () => {
    const ircDock = getChannelDock("irc");
    const cfg = {
      channels: {
        irc: {
          defaultTo: "#root",
          accounts: {
            Work: { defaultTo: "#work" },
          },
        },
      },
    } as OpenClawConfig;

    const accountDefault = ircDock?.config?.resolveDefaultTo?.({ cfg, accountId: "work" });
    const rootDefault = ircDock?.config?.resolveDefaultTo?.({ cfg, accountId: "missing" });

    expect(accountDefault).toBe("#work");
    expect(rootDefault).toBe("#root");
  });

  it("signal allowFrom formatter normalizes values and preserves wildcard", () => {
    const signalDock = getChannelDock("signal");

    const formatted = signalDock?.config?.formatAllowFrom?.({
      cfg: emptyConfig(),
      allowFrom: [" signal:+14155550100 ", " * "],
    });

    expect(formatted).toEqual(["+14155550100", "*"]);
  });

  it("telegram allowFrom formatter trims, strips prefix, and lowercases", () => {
    const telegramDock = getChannelDock("telegram");

    const formatted = telegramDock?.config?.formatAllowFrom?.({
      cfg: emptyConfig(),
      allowFrom: [" TG:User ", "telegram:Foo", " Plain "],
    });

    expect(formatted).toEqual(["user", "foo", "plain"]);
  });
});
