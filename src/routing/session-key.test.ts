import { expect, it, vi } from "vitest";

vi.unmock("./session-key.js");
import { resolveSessionStoreKey } from "../gateway/session-store-key.js";
import {
  parseCronRunScopeSuffix,
  parseThreadSessionSuffix,
} from "../sessions/session-key-utils.js";
import {
  agentSessionKeysMatchByRequestKey,
  buildAgentPeerSessionKey,
  buildGroupHistoryKey,
  classifySessionKeyShape,
  parseAgentSessionKey,
  resolveAgentIdFromSessionKey,
  resolveEventSessionKey,
  isUnscopedSessionKeySentinel,
  scopeLegacySessionKeyToAgent,
  toAgentStoreSessionKey,
} from "./session-key.js";

const scopeLegacy = (sessionKey: string, mainKey?: string) =>
  scopeLegacySessionKeyToAgent({ agentId: "Ops", sessionKey, mainKey });

it("keeps legacy agent ids absent until a configured default resolves them", () => {
  expect(parseAgentSessionKey("main")?.agentId).toBeUndefined();
  expect(() => resolveAgentIdFromSessionKey("main")).toThrow("configured default agent");
  expect(() => resolveAgentIdFromSessionKey("main", "   ")).toThrow("configured default agent");
  expect(resolveAgentIdFromSessionKey("main", "primary")).toBe("primary");
  expect(resolveAgentIdFromSessionKey("agent:worker:main", "primary")).toBe("worker");
  expect(() => resolveAgentIdFromSessionKey("agent::secret", "primary")).toThrow(
    "Malformed agent session key",
  );
});

it("classifies an absent session key as missing", () => {
  expect(classifySessionKeyShape(undefined)).toBe("missing");
});

it("scopes legacy aliases to the requested agent", () => {
  expect(scopeLegacy("Incident-42")).toBe("agent:ops:incident-42");
});

it("honors configured main-key aliases when scoping legacy keys", () => {
  expect(scopeLegacy("main", "work")).toBe("agent:ops:work");
});

it("preserves already agent-prefixed keys", () => {
  expect(scopeLegacy("agent:main:incident-42")).toBe("agent:main:incident-42");
});

it("recognizes literal global and unknown sentinels", () => {
  expect(isUnscopedSessionKeySentinel("global")).toBe(true);
  expect(isUnscopedSessionKeySentinel("UNKNOWN")).toBe(true);
  expect(isUnscopedSessionKeySentinel("agent:ops:global")).toBe(false);
  expect(isUnscopedSessionKeySentinel("incident-42")).toBe(false);
});

it.each([
  ["incident-42", "agent:ops:incident-42", true],
  ["agent:OPS:incident-42", "agent:ops:incident-42", true],
  ["agent:ops:incident-42", "agent:research:incident-42", false],
  ["agent:ops:incident-42", "main", false],
] as const)("compares %s with %s without losing a qualified owner", (left, right, expected) => {
  expect(agentSessionKeysMatchByRequestKey(left, right)).toBe(expected);
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

it("parses mixed-case run markers without lowercasing the stored key", () => {
  expect(parseCronRunScopeSuffix("AGENT:Work:CRON:Nightly-Job:RUN:ABC-123")).toEqual({
    baseSessionKey: "AGENT:Work:CRON:Nightly-Job",
    runId: "ABC-123",
  });
});

it("does not strip a :run: segment from a non-cron key", () => {
  const key = "agent:main:slack:channel:general:run:42";
  expect(parseCronRunScopeSuffix(key)).toEqual({ baseSessionKey: key, runId: undefined });
});

it("does not treat a non-terminal cron :run: as a run scope", () => {
  const key = "agent:main:cron:run:job:run:abc:extra";
  expect(parseCronRunScopeSuffix(key)).toEqual({ baseSessionKey: key, runId: undefined });
});

it("does not double-prefix already-qualified agent keys", () => {
  expect(toAgentStoreSessionKey({ agentId: "main", requestKey: "agent:main:main" })).toBe(
    "agent:main:main",
  );
});

it("preserves Signal group ids in group history keys", () => {
  const peerId = "VWATodkf2hc8zdOS76q9Tb0+5Bi522E03qLdaQ/9ypg=";
  expect(buildGroupHistoryKey({ channel: "Signal", peerKind: "group", peerId })).toBe(
    `signal:default:group:${peerId}`,
  );
});

it("keeps non-Signal opaque-looking group ids lowercase", () => {
  expect(
    buildAgentPeerSessionKey({
      agentId: "Main",
      channel: "Telegram",
      peerKind: "group",
      peerId: "MiXeDGroup",
    }),
  ).toBe("agent:main:telegram:group:mixedgroup");
});

it("preserves durable cron base event session keys", () => {
  expect(resolveEventSessionKey("agent:ops:cron:job-1")).toBe("agent:ops:cron:job-1");
});

it("respects custom mainKey for ephemeral cron event session remapping", () => {
  expect(resolveEventSessionKey("agent:main:cron:backup:run:abc123", "primary", "per-sender")).toBe(
    "agent:main:primary",
  );
});

it("routes cron-run keys to the global queue when scope is global", () => {
  expect(resolveEventSessionKey("agent:ops:cron:job-1:run:xyz", undefined, "global")).toBe(
    "global",
  );
  expect(
    resolveEventSessionKey("agent:main:cron:backup:run:abc:subagent:worker", "primary", "global"),
  ).toBe("global");
});
