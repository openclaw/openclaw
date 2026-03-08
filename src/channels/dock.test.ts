import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { withEnv } from "../test-utils/env.js";
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

  it("discord threading falls back to From for direct chats", () => {
    const hasRepliedRef = { value: false };
    const discordDock = getChannelDock("discord");
    const context = discordDock?.threading?.buildToolContext?.({
      cfg: emptyConfig(),
      context: {
        ChatType: "direct",
        From: "discord:1234567890",
        To: "",
        ReplyToId: "msg-1",
      },
      hasRepliedRef,
    });

    expect(context).toEqual({
      currentChannelId: "discord:1234567890",
      currentThreadTs: "msg-1",
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
    } as unknown as OpenClawConfig;

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

  it("telegram dock config readers preserve omitted-account fallback semantics", () => {
    withEnv({ TELEGRAM_BOT_TOKEN: "tok-env" }, () => {
      const telegramDock = getChannelDock("telegram");
      const cfg = {
        channels: {
          telegram: {
            allowFrom: ["top-owner"],
            defaultTo: "@top-target",
            accounts: {
              work: {
                botToken: "tok-work",
                allowFrom: ["work-owner"],
                defaultTo: "@work-target",
              },
            },
          },
        },
      } as unknown as OpenClawConfig;

      expect(telegramDock?.config?.resolveAllowFrom?.({ cfg })).toEqual(["top-owner"]);
      expect(telegramDock?.config?.resolveDefaultTo?.({ cfg })).toBe("@top-target");
    });
  });

  it("slack dock config readers stay read-only when tokens are unresolved SecretRefs", () => {
    const slackDock = getChannelDock("slack");
    const cfg = {
      channels: {
        slack: {
          botToken: {
            source: "env",
            provider: "default",
            id: "SLACK_BOT_TOKEN",
          },
          appToken: {
            source: "env",
            provider: "default",
            id: "SLACK_APP_TOKEN",
          },
          defaultTo: "channel:C111",
          dm: { allowFrom: ["U123"] },
          channels: {
            C111: { requireMention: false },
          },
          replyToMode: "all",
        },
      },
    } as unknown as OpenClawConfig;

    expect(slackDock?.config?.resolveAllowFrom?.({ cfg, accountId: "default" })).toEqual(["U123"]);
    expect(slackDock?.config?.resolveDefaultTo?.({ cfg, accountId: "default" })).toBe(
      "channel:C111",
    );
    expect(
      slackDock?.threading?.resolveReplyToMode?.({
        cfg,
        accountId: "default",
        chatType: "channel",
      }),
    ).toBe("all");
    expect(
      slackDock?.groups?.resolveRequireMention?.({
        cfg,
        accountId: "default",
        groupId: "C111",
      }),
    ).toBe(false);
  });

  it("dock config readers coerce numeric allowFrom/defaultTo entries through shared helpers", () => {
    const telegramDock = getChannelDock("telegram");
    const signalDock = getChannelDock("signal");
    const cfg = {
      channels: {
        telegram: {
          allowFrom: [12345],
          defaultTo: 67890,
        },
        signal: {
          allowFrom: [14155550100],
          defaultTo: 42,
        },
      },
    } as unknown as OpenClawConfig;

    expect(telegramDock?.config?.resolveAllowFrom?.({ cfg })).toEqual(["12345"]);
    expect(telegramDock?.config?.resolveDefaultTo?.({ cfg })).toBe("67890");
    expect(signalDock?.config?.resolveAllowFrom?.({ cfg })).toEqual(["14155550100"]);
    expect(signalDock?.config?.resolveDefaultTo?.({ cfg })).toBe("42");
  });
});
