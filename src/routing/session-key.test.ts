import { expect, it, vi } from "vitest";

vi.unmock("./session-key.js");
import { resolveSessionStoreKey } from "../gateway/session-store-key.js";
import {
  parseCronRunScopeSuffix,
  parseThreadSessionSuffix,
} from "../sessions/session-key-utils.js";
import * as keys from "./session-key.js";

const scopeLegacy = (sessionKey: string, mainKey?: string) =>
  keys.scopeLegacySessionKeyToAgent({ agentId: "Ops", sessionKey, mainKey });

it("keeps legacy agent ids absent until a configured default resolves them", () => {
  expect(keys.parseAgentSessionKey("main")?.agentId).toBeUndefined();
  expect(() => keys.resolveAgentIdFromSessionKey("main")).toThrow("configured default agent");
  expect(() => keys.resolveAgentIdFromSessionKey("main", "   ")).toThrow(
    "configured default agent",
  );
  expect(keys.resolveAgentIdFromSessionKey("main", "primary")).toBe("primary");
  expect(keys.resolveAgentIdFromSessionKey("agent:worker:main", "primary")).toBe("worker");
  expect(() => keys.resolveAgentIdFromSessionKey("agent::secret", "primary")).toThrow(
    "Malformed agent session key",
  );
});

it("classifies an absent session key as missing", () => {
  expect(keys.classifySessionKeyShape(undefined)).toBe("missing");
});

it.each([
  ["Incident-42", undefined, "agent:ops:incident-42"],
  ["main", "work", "agent:ops:work"],
  ["agent:main:incident-42", undefined, "agent:main:incident-42"],
] as const)("scopes legacy key %s with main alias %s", (key, mainKey, expected) => {
  expect(scopeLegacy(key, mainKey)).toBe(expected);
});

it("recognizes literal global and unknown sentinels", () => {
  expect(keys.isUnscopedSessionKeySentinel("global")).toBe(true);
  expect(keys.isUnscopedSessionKeySentinel("UNKNOWN")).toBe(true);
  expect(keys.isUnscopedSessionKeySentinel("agent:ops:global")).toBe(false);
  expect(keys.isUnscopedSessionKeySentinel("incident-42")).toBe(false);
});

it.each([
  ["incident-42", "agent:ops:incident-42", true],
  ["agent:OPS:incident-42", "agent:ops:incident-42", true],
  ["agent:ops:incident-42", "agent:research:incident-42", false],
  ["agent:ops:incident-42", "main", false],
] as const)("compares %s with %s without losing a qualified owner", (left, right, expected) => {
  expect(keys.agentSessionKeysMatchByRequestKey(left, right)).toBe(expected);
});

it("scopes unprefixed explicit-agent keys to the requested store agent", () => {
  const cfg = { agents: { entries: { main: {}, ops: {} } }, session: { mainKey: "primary" } };
  const main = resolveSessionStoreKey({ cfg, sessionKey: "main", storeAgentId: "ops" });
  const dm = resolveSessionStoreKey({ cfg, sessionKey: "discord:dm:U1", storeAgentId: "ops" });
  expect([main, dm]).toEqual(["agent:ops:primary", "agent:ops:discord:dm:u1"]);
});

it("preserves feishu conversation ids that embed :topic: in the base id", () => {
  const key = "agent:main:feishu:group:oc_group_chat:topic:om_topic_root:sender:ou_topic_user";
  expect(parseThreadSessionSuffix(key)).toEqual({ baseSessionKey: key, threadId: undefined });
});

it("parses mixed-case :thread: markers without lowercasing the stored key", () => {
  expect(
    parseThreadSessionSuffix("agent:main:slack:channel:General:Thread:1699999999.0001"),
  ).toEqual({
    baseSessionKey: "agent:main:slack:channel:General",
    threadId: "1699999999.0001",
  });
});

it.each([
  ["AGENT:Work:CRON:Nightly-Job:RUN:ABC-123", "AGENT:Work:CRON:Nightly-Job", "ABC-123"],
  ["agent:main:slack:channel:general:run:42", "agent:main:slack:channel:general:run:42", undefined],
  ["agent:main:cron:run:job:run:abc:extra", "agent:main:cron:run:job:run:abc:extra", undefined],
] as const)("parses case-preserving terminal cron scope: %s", (key, baseSessionKey, runId) => {
  expect(parseCronRunScopeSuffix(key)).toEqual({ baseSessionKey, runId });
});

it("does not double-prefix already-qualified agent keys", () => {
  expect(keys.toAgentStoreSessionKey({ agentId: "main", requestKey: "agent:main:main" })).toBe(
    "agent:main:main",
  );
});

it("preserves Signal group ids in group history keys", () => {
  const peerId = "VWATodkf2hc8zdOS76q9Tb0+5Bi522E03qLdaQ/9ypg=";
  expect(keys.buildGroupHistoryKey({ channel: "Signal", peerKind: "group", peerId })).toBe(
    `signal:default:group:${peerId}`,
  );
});

it("keeps non-Signal opaque-looking group ids lowercase", () => {
  expect(
    keys.buildAgentPeerSessionKey({
      agentId: "Main",
      channel: "Telegram",
      peerKind: "group",
      peerId: "MiXeDGroup",
    }),
  ).toBe("agent:main:telegram:group:mixedgroup");
});

it.each([
  ["agent:ops:cron:job-1", undefined, undefined, "agent:ops:cron:job-1"],
  ["agent:main:cron:backup:run:abc123", "primary", "per-sender", "agent:main:primary"],
  ["agent:ops:cron:job-1:run:xyz", undefined, "global", "global"],
  ["agent:main:cron:backup:run:abc:subagent:worker", "primary", "global", "global"],
] as const)("routes cron event %s to its scoped queue", (key, mainKey, scope, expected) => {
  expect(keys.resolveEventSessionKey(key, mainKey, scope)).toBe(expected);
});
