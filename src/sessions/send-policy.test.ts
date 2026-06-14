// Session send policy tests cover message send eligibility decisions.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import { buildAgentPeerSessionKey } from "../routing/session-key.js";
import { resolveSendPolicy } from "./send-policy.js";

describe("resolveSendPolicy", () => {
  const cfgWithRules = (
    rules: NonNullable<NonNullable<OpenClawConfig["session"]>["sendPolicy"]>["rules"],
  ) =>
    ({
      session: {
        sendPolicy: {
          default: "allow",
          rules,
        },
      },
    }) as OpenClawConfig;

  it("defaults to allow", () => {
    const cfg = {} as OpenClawConfig;
    expect(resolveSendPolicy({ cfg })).toBe("allow");
  });

  it("entry override wins", () => {
    const cfg = {
      session: { sendPolicy: { default: "allow" } },
    } as OpenClawConfig;
    const entry: SessionEntry = {
      sessionId: "s",
      updatedAt: 0,
      sendPolicy: "deny",
    };
    expect(resolveSendPolicy({ cfg, entry })).toBe("deny");
  });

  it.each([
    {
      name: "rule match by channel + chatType",
      cfg: cfgWithRules([
        { action: "deny", match: { channel: "demo-channel", chatType: "group" } },
      ]),
      entry: {
        sessionId: "s",
        updatedAt: 0,
        channel: "demo-channel",
        chatType: "group",
      } as SessionEntry,
      sessionKey: "demo-channel:group:dev",
      expected: "deny",
    },
    {
      name: "rule match by keyPrefix",
      cfg: cfgWithRules([{ action: "deny", match: { keyPrefix: "cron:" } }]),
      sessionKey: "cron:job-1",
      expected: "deny",
    },
    {
      name: "rule match by rawKeyPrefix",
      cfg: cfgWithRules([{ action: "deny", match: { rawKeyPrefix: "agent:main:demo-channel:" } }]),
      sessionKey: "agent:main:demo-channel:group:dev",
      expected: "deny",
    },
    {
      name: "rawKeyPrefix does not match other channels",
      cfg: cfgWithRules([{ action: "deny", match: { rawKeyPrefix: "agent:main:demo-channel:" } }]),
      sessionKey: "agent:main:other-channel:group:dev",
      expected: "allow",
    },
    {
      name: "channel-scoped deny fires for direct session key without explicit channel field",
      cfg: cfgWithRules([{ action: "deny", match: { channel: "demo-channel" } }]),
      sessionKey: "demo-channel:direct:user-1",
      expected: "deny",
    },
    {
      name: "channel-scoped deny fires for per-account-channel-peer DM key without explicit channel field",
      cfg: cfgWithRules([{ action: "deny", match: { channel: "demo-channel" } }]),
      sessionKey: buildAgentPeerSessionKey({
        agentId: "main",
        channel: "demo-channel",
        accountId: "acct-1",
        peerKind: "direct",
        peerId: "user-1",
        dmScope: "per-account-channel-peer",
      }),
      expected: "deny",
    },
    {
      name: "channel-scoped deny ignores later peer-kind-looking tokens in non-channel keys",
      cfg: cfgWithRules([{ action: "deny", match: { channel: "demo-channel" } }]),
      sessionKey: "demo-channel:not-a-peer-kind:user-1:direct",
      expected: "allow",
    },
    {
      name: "channel-scoped deny ignores incomplete account-scoped keys",
      cfg: cfgWithRules([{ action: "deny", match: { channel: "demo-channel" } }]),
      sessionKey: "demo-channel:acct-1:direct",
      expected: "allow",
    },
  ])("$name", ({ cfg, entry, sessionKey, expected }) => {
    expect(resolveSendPolicy({ cfg, entry, sessionKey })).toBe(expected);
  });
});
