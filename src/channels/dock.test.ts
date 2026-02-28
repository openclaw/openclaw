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
      context: {
        To: " room-1 ",
        MessageThreadId: 42,
        ReplyToId: "fallback",
        CurrentMessageId: "9001",
      },
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
      currentMessageId: "9001",
      hasRepliedRef,
    });
    expect(googleChatContext).toEqual({
      currentChannelId: "space-1",
      currentThreadTs: "thread-abc",
      hasRepliedRef,
    });
  });

  it("telegram threading does not treat ReplyToId as thread id in DMs", () => {
    const hasRepliedRef = { value: false };
    const telegramDock = getChannelDock("telegram");
    const context = telegramDock?.threading?.buildToolContext?.({
      cfg: emptyConfig(),
      context: { To: " dm-1 ", ReplyToId: "12345", CurrentMessageId: "12345" },
      hasRepliedRef,
    });

    expect(context).toEqual({
      currentChannelId: "dm-1",
      currentThreadTs: undefined,
      currentMessageId: "12345",
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
