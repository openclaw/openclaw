import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import { SessionSendPolicySchema } from "../config/zod-schema.session.js";
import { resolveSendPolicy, resolveSendPolicyDetailed } from "./send-policy.js";

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
  ])("$name", ({ cfg, entry, sessionKey, expected }) => {
    expect(resolveSendPolicy({ cfg, entry, sessionKey })).toBe(expected);
  });

  it("accepts relational peer rules in the session config schema", () => {
    expect(
      SessionSendPolicySchema.safeParse({
        default: "allow",
        rules: [
          {
            action: "deny",
            match: {
              allOf: [{ channel: "telegram" }, { peerEquals: "inboundPeer", invert: true }],
            },
          },
        ],
      }).success,
    ).toBe(true);
  });

  it("matches outbound peers against the inbound peer", () => {
    const cfg = {
      session: {
        sendPolicy: {
          default: "deny",
          rules: [{ action: "allow", match: { peerEquals: "inboundPeer" } }],
        },
      },
    } as OpenClawConfig;

    expect(
      resolveSendPolicy({
        cfg,
        inboundPeer: "User-1",
        outboundPeer: "user-1",
      }),
    ).toBe("allow");
    expect(
      resolveSendPolicy({
        cfg,
        inboundPeer: "User-1",
        outboundPeer: "user-2",
      }),
    ).toBe("deny");
  });

  it("denies mismatched peers with structured cancel metadata", () => {
    const cfg = {
      session: {
        sendPolicy: {
          default: "allow",
          rules: [{ action: "deny", match: { peerEquals: "inboundPeer", invert: true } }],
        },
      },
    } as OpenClawConfig;

    expect(
      resolveSendPolicyDetailed({
        cfg,
        inboundPeer: ["user-1", "alias-1"],
        outboundPeer: "user-2",
      }),
    ).toEqual({
      decision: "deny",
      cancelReason: {
        code: "send_policy_peer_mismatch",
        peerEquals: "inboundPeer",
        expectedPeer: "user-1",
        expectedPeers: ["user-1", "alias-1"],
        actualPeer: "user-2",
      },
    });
  });

  it("does not let missing inbound peer context trigger inverted peer denies", () => {
    const cfg = {
      session: {
        sendPolicy: {
          default: "allow",
          rules: [{ action: "deny", match: { peerEquals: "inboundPeer", invert: true } }],
        },
      },
    } as OpenClawConfig;

    expect(resolveSendPolicy({ cfg, outboundPeer: "user-2" })).toBe("allow");
  });

  it("composes peer rules with static predicates", () => {
    const cfg = {
      session: {
        sendPolicy: {
          default: "allow",
          rules: [
            {
              action: "deny",
              match: {
                allOf: [{ channel: "telegram" }, { peerEquals: "inboundPeer", invert: true }],
              },
            },
          ],
        },
      },
    } as OpenClawConfig;

    expect(
      resolveSendPolicy({
        cfg,
        channel: "telegram",
        inboundPeer: "user-1",
        outboundPeer: "user-2",
      }),
    ).toBe("deny");
    expect(
      resolveSendPolicy({
        cfg,
        channel: "slack",
        inboundPeer: "user-1",
        outboundPeer: "user-2",
      }),
    ).toBe("allow");
  });
});
