import { expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import { buildAgentPeerSessionKey } from "../routing/session-key.js";
import { resolveSendPolicy } from "./send-policy.js";

const cfgWithRules = (
  rules: NonNullable<NonNullable<OpenClawConfig["session"]>["sendPolicy"]>["rules"],
  fallback: "allow" | "deny" = "allow",
): OpenClawConfig => ({ session: { sendPolicy: { default: fallback, rules } } });

it("defaults to allow", () => {
  expect(resolveSendPolicy({ cfg: {} })).toBe("allow");
});

it("entry override wins", () => {
  const entry: SessionEntry = {
    sessionId: "s",
    updatedAt: 0,
    sendPolicy: "deny",
  };
  expect(resolveSendPolicy({ cfg: cfgWithRules([]), entry })).toBe("deny");
});

type Match = NonNullable<NonNullable<Parameters<typeof cfgWithRules>[0]>[number]>["match"];
it.each<[string, Match, string, "allow" | "deny", SessionEntry?]>([
  [
    "channel + chatType metadata",
    { channel: "demo-channel", chatType: "group" },
    "demo-channel:group:dev",
    "deny",
    { sessionId: "s", updatedAt: 0, channel: "demo-channel", chatType: "group" },
  ],
  ["key prefix", { keyPrefix: "cron:" }, "cron:job-1", "deny"],
  [
    "raw prefix match",
    { rawKeyPrefix: "agent:main:demo-channel:" },
    "agent:main:demo-channel:group:dev",
    "deny",
  ],
  [
    "raw prefix mismatch",
    { rawKeyPrefix: "agent:main:demo-channel:" },
    "agent:main:other-channel:group:dev",
    "allow",
  ],
  [
    "direct key without metadata",
    { channel: "demo-channel" },
    "demo-channel:direct:user-1",
    "deny",
  ],
  [
    "account-scoped DM without metadata",
    { channel: "demo-channel" },
    buildAgentPeerSessionKey({
      agentId: "main",
      channel: "demo-channel",
      accountId: "acct-1",
      peerKind: "direct",
      peerId: "user-1",
      dmScope: "per-account-channel-peer",
    }),
    "deny",
  ],
  [
    "per-peer DM without metadata",
    { chatType: "direct" },
    buildAgentPeerSessionKey({
      agentId: "main",
      channel: "demo-channel",
      peerKind: "direct",
      peerId: "user-1",
      dmScope: "per-peer",
    }),
    "deny",
  ],
  [
    "opaque Matrix peer",
    { channel: "matrix" },
    "agent:main:matrix:channel:!room:[2001:db8::1]",
    "deny",
  ],
  [
    "colon-bearing legacy channel",
    { chatType: "channel" },
    "agent:main:channel:!room:example.org",
    "deny",
  ],
  ["legacy/canonical overlap", { chatType: "channel" }, "agent:main:channel:direct:user", "deny"],
  [
    "ambiguous account and peer kind",
    { chatType: "direct" },
    "agent:main:telegram:group:direct:user",
    "deny",
  ],
  ["bare direct with channel shape", { channel: "direct" }, "agent:main:direct:group:room", "deny"],
  ["bare DM with account shape", { chatType: "group" }, "agent:main:dm:account:group:room", "deny"],
  [
    "late peer-kind token",
    { channel: "demo-channel" },
    "demo-channel:not-a-peer-kind:user-1:direct",
    "allow",
  ],
  ["incomplete account key", { channel: "demo-channel" }, "demo-channel:acct-1:direct", "allow"],
])("%s", (_name, match, sessionKey, expected, entry) => {
  const cfg = cfgWithRules([{ action: "deny", match }]);
  expect(resolveSendPolicy({ cfg, entry, sessionKey })).toBe(expected);
});

it("does not apply channel allow rules to nested opaque identities", () => {
  const cfg = cfgWithRules(
    [
      { action: "allow", match: { channel: "matrix" } },
      { action: "allow", match: { chatType: "channel" } },
    ],
    "deny",
  );

  expect(
    resolveSendPolicy({
      cfg,
      sessionKey: "agent:voice:agent:other:matrix:channel:!room:example.org",
    }),
  ).toBe("deny");
  expect(
    resolveSendPolicy({
      cfg,
      sessionKey: "agent:voice:agent:voice::matrix:channel:!roomabc:example.org",
    }),
  ).toBe("deny");
});

it.each([
  "agent:main:direct",
  "agent:main:demo:acct:channel",
  "agent:main:demo::channel:room",
  "agent::demo:direct:user",
])("does not apply peer allow rules to malformed key %s", (sessionKey) => {
  const cfg = cfgWithRules(
    [
      { action: "allow", match: { channel: "demo" } },
      { action: "allow", match: { chatType: "direct" } },
      { action: "allow", match: { chatType: "channel" } },
    ],
    "deny",
  );

  expect(resolveSendPolicy({ cfg, sessionKey })).toBe("deny");
});
