import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveSessionRelayRoute } from "./relay-routing.js";

describe("resolveSessionRelayRoute", () => {
  it("defaults to read-write when relay routing is unconfigured", () => {
    const cfg = {} as OpenClawConfig;
    const route = resolveSessionRelayRoute({
      cfg,
      channel: "imessage",
      sourceTo: "chat_id:1",
    });
    expect(route.mode).toBe("read-write");
    expect(route.output).toBeUndefined();
    expect(route.source.channel).toBe("imessage");
    expect(route.source.to).toBe("chat_id:1");
  });

  it("matches read-only relay rules by channel + chatType", () => {
    const cfg = {
      session: {
        relayRouting: {
          targets: {
            telegramPrimary: {
              channel: "telegram",
              to: "12345",
              accountId: "work",
            },
          },
          rules: [
            {
              mode: "read-only",
              relayTo: "telegramPrimary",
              match: { channel: "imessage", chatType: "direct" },
            },
          ],
        },
      },
    } as OpenClawConfig;
    const route = resolveSessionRelayRoute({
      cfg,
      channel: "imessage",
      chatType: "direct",
      sessionKey: "agent:main:imessage:+1555",
      sourceTo: "chat_id:7",
    });
    expect(route.mode).toBe("read-only");
    expect(route.matchedRuleIndex).toBe(0);
    expect(route.output).toEqual({
      targetKey: "telegramPrimary",
      channel: "telegram",
      to: "12345",
      accountId: "work",
      threadId: undefined,
    });
  });

  it("matches rules by keyPrefix and rawKeyPrefix", () => {
    const cfg = {
      session: {
        relayRouting: {
          targets: {
            tg: { channel: "telegram", to: "12345" },
          },
          rules: [
            {
              mode: "read-only",
              relayTo: "tg",
              match: { keyPrefix: "discord:group:" },
            },
            {
              mode: "read-write",
              match: { rawKeyPrefix: "agent:main:slack:" },
            },
          ],
        },
      },
    } as OpenClawConfig;
    const discordRoute = resolveSessionRelayRoute({
      cfg,
      sessionKey: "agent:main:discord:group:dev",
    });
    expect(discordRoute.mode).toBe("read-only");
    expect(discordRoute.output?.channel).toBe("telegram");

    const slackRoute = resolveSessionRelayRoute({
      cfg,
      sessionKey: "agent:main:slack:group:ops",
    });
    expect(slackRoute.mode).toBe("read-write");
    expect(slackRoute.matchedRuleIndex).toBe(1);
  });

  it("respects first matching rule order", () => {
    const cfg = {
      session: {
        relayRouting: {
          targets: {
            tg: { channel: "telegram", to: "12345" },
          },
          rules: [
            {
              mode: "read-write",
              match: { channel: "imessage" },
            },
            {
              mode: "read-only",
              relayTo: "tg",
              match: { channel: "imessage" },
            },
          ],
        },
      },
    } as OpenClawConfig;
    const route = resolveSessionRelayRoute({
      cfg,
      channel: "imessage",
    });
    expect(route.mode).toBe("read-write");
    expect(route.matchedRuleIndex).toBe(0);
  });

  it("falls back to defaultMode and single target for unmatched routes", () => {
    const cfg = {
      session: {
        relayRouting: {
          defaultMode: "read-only",
          targets: {
            tg: { channel: "telegram", to: "12345" },
          },
          rules: [
            {
              mode: "read-write",
              match: { channel: "slack" },
            },
          ],
        },
      },
    } as OpenClawConfig;
    const route = resolveSessionRelayRoute({
      cfg,
      channel: "imessage",
    });
    expect(route.mode).toBe("read-only");
    expect(route.output?.targetKey).toBe("tg");
  });

  it("falls back to read-write when default read-only target is ambiguous", () => {
    const cfg = {
      session: {
        relayRouting: {
          defaultMode: "read-only",
          targets: {
            tg: { channel: "telegram", to: "12345" },
            signalPrimary: { channel: "signal", to: "+1555" },
          },
        },
      },
    } as OpenClawConfig;
    const route = resolveSessionRelayRoute({
      cfg,
      channel: "imessage",
    });
    expect(route.mode).toBe("read-write");
    expect(route.output).toBeUndefined();
  });
});
