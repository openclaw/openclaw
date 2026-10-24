import * as sessionKeyNormalization from "@openclaw/normalization-core/session-key-comparison";
// @vitest-environment node
import { parseAgentSessionKeyParts } from "@openclaw/session-url-contract";
import { afterEach, expect, it, vi } from "vitest";
import {
  areUiSessionKeysEquivalent,
  normalizeDefaultMainSessionAliasForUi,
  canArchiveSessionRow,
  canDeleteSessionRows,
  canonicalUiSessionKeyForPersistence,
  isUiSelectedGlobalSessionKey,
  isPinnableUiSessionRow,
  normalizeSessionKeyForUiComparison,
  parseAgentSessionKey,
  parseSessionKeyParts,
  resolveAgentIdFromSessionKey,
  resolveUiSessionNavigationParentKey,
  resolveUiConversationIdentity,
  uiSessionEventMatches,
  uiSessionRowMatchesSelectedChat,
} from "./session-key.ts";

const defaults = { defaultAgentId: "ops", mainKey: "home", mainSessionKey: "agent:ops:current" };

it.each([
  ["agent:ops:dingtalk:AbC", "ops", "dingtalk:AbC", "dingtalk:abc"],
  ["main", null, null, null],
  ["agent:ops:room::part", "ops", "room::part", "room:part"],
  ["agent:ops:main:", "ops", "main:", "main"],
  ["agent:ops::cron:job", "ops", null, "cron:job"],
  ["agent::cron:job", "cron", null, "job"],
  [":agent:ops:main", "ops", null, "main"],
  ["agent:ops: :", "ops", " :", " "],
] as const)("adapts ownership and tail for %s", (key, agentId, rawRest, rest) => {
  expect(parseAgentSessionKeyParts(key)).toEqual(
    rawRest === null ? null : { agentId, rest: rawRest },
  );
  expect(parseAgentSessionKey(key)).toEqual(rest === null ? null : { agentId, rest });
  expect(resolveAgentIdFromSessionKey(key)).toBe(agentId ?? "main");
});

it.each([
  ["active non-main", [{ key: "agent:main:work", hasActiveRun: true }], true, false],
  ["configured main", [{ key: "agent:main:home" }], false, false],
  ["literal main", [{ key: "main" }], false, false],
  ["global", [{ key: "global", kind: "global" }], false, false],
  ["unknown", [{ key: "unknown", kind: "unknown" }], false, false],
  ["archived global", [{ key: "global", kind: "global", archived: true }], false, true],
  ["missing identity", [{ key: "agent:main:work", sessionId: undefined }], false, true],
  [
    "mixed archived and idle",
    [
      { key: "global", kind: "global", archived: true },
      { key: "agent:main:work", archived: false },
    ],
    false,
    false,
  ],
] as const)("classifies %s", (_name, rows, archiveAllowed, deleteAllowed) => {
  expect(canArchiveSessionRow({ sessionId: "durable-session", ...rows[0] }, "home")).toBe(
    archiveAllowed,
  );
  expect(canDeleteSessionRows(rows, "home")).toBe(deleteAllowed);
});

it.each([
  ["agent:m:telegram:u:1:x", { agentId: "m", channel: "telegram", accountId: "u:1:x" }],
  ["Agent:main:telegram:user", null],
] as const)("parses opaque channel accounts in %j", (key, expected) => {
  expect(parseSessionKeyParts(key)).toEqual(expected);
});

afterEach(() => vi.restoreAllMocks());

it.each([undefined, " \t\n", "main"])(
  "preserves nonblank equivalence for identical %j inputs",
  (key) => expect(areUiSessionKeysEquivalent(key, key)).toBe(Boolean(key?.trim())),
);

it("reuses comparison keys until bounded eviction without changing their identities", () => {
  const normalize = vi.spyOn(sessionKeyNormalization, "normalizeSessionKeyForComparison");
  const keys = [
    [" Agent:Cache:Matrix:Channel:!R:E.Org ", "agent:cache:matrix:channel:!R:E.Org"],
    [" MAIN \t", "agent:main:main"],
    ["Agent:MemoEviction:Signal:Group:AbC=", "agent:memoeviction:signal:group:AbC="],
  ] as const;
  for (const [key, expected] of keys) {
    for (let i = 0; i < 10; i++) {
      expect(normalizeDefaultMainSessionAliasForUi(key)).toBe(expected);
      expect(areUiSessionKeysEquivalent(key, expected)).toBe(true);
    }
    expect(normalize.mock.calls.filter(([value]) => value === key)).toHaveLength(1);
  }
  for (let i = 0; i < 4096; i++) {
    normalizeSessionKeyForUiComparison(`Agent:MemoEviction:Dashboard:${i}`);
  }
  for (const [key, expected] of keys) {
    expect(normalizeDefaultMainSessionAliasForUi(key)).toBe(expected);
    expect(normalize.mock.calls.filter(([value]) => value === key)).toHaveLength(2);
  }
});

it.each([
  ["catalog:fixture:N%3AA:T%3AB", "catalog:fixture:N%3AA:T%3AB", "catalog:fixture:N%3AA:t%3Ab"],
  [
    "matrix:channel:!R:E:thread:$E",
    "Matrix:Channel:!R:E:Thread:$E",
    "matrix:channel:!R:E:thread:$e",
  ],
  ["signal:group:AbC=:thread:xyz", "Signal:Group:AbC=:Thread:XyZ", "signal:group:abc=:thread:xyz"],
])("preserves opaque IDs in %s for live events and persistence", (selected, alias, distinct) => {
  const selectedKey = `agent:ops:${selected}`;
  const structuralAlias = `Agent:Ops:${alias}`;
  const distinctKey = `agent:ops:${distinct}`;
  const host = {
    agentsList: { defaultId: "ops", mainKey: "home" },
    sessionKey: selectedKey,
  };

  expect(areUiSessionKeysEquivalent(selectedKey, structuralAlias)).toBe(true);
  expect(areUiSessionKeysEquivalent(selectedKey, distinctKey)).toBe(false);
  expect(uiSessionEventMatches(host, structuralAlias)).toBe(true);
  expect(uiSessionEventMatches(host, distinctKey)).toBe(false);
  expect(canonicalUiSessionKeyForPersistence(host, structuralAlias)).toBe(selectedKey);
  expect(canonicalUiSessionKeyForPersistence(host, distinctKey)).toBe(distinctKey);
});

it.each([
  ["main", undefined, "agent:ops:current", "ops"],
  ["home", undefined, "agent:ops:current", "ops"],
  ["agent:work:main", undefined, "agent:work:home", "work"],
  ["main", { defaultId: "work", mainKey: "home" }, "agent:work:home", "work"],
  ["main", { defaultId: "ops", mainKey: "next" }, "agent:ops:next", "ops"],
  ["main", { defaultId: "ops", mainKey: "home", scope: "global" }, "global", "ops"],
  ["main", undefined, "agent:work:home", "work", "work"],
  ["main", { defaultId: "ops", mainKey: "home", scope: "global" }, "global", "work", "work"],
  ["agent:ops:main", undefined, "agent:ops:current", "ops", "work"],
] as const)(
  "uses advertised main identity for %s without overriding current roster %j",
  (key, agentsList, sessionKey, agentId, agentIdOverride?: string) => {
    const host = {
      agentsList,
      assistantAgentId: agentId,
      hello: { snapshot: { sessionDefaults: defaults } },
    };
    expect(resolveUiConversationIdentity(host, key, agentIdOverride)).toEqual({
      sessionKey,
      agentId,
    });
    expect(uiSessionEventMatches({ ...host, sessionKey }, key, agentId)).toBe(true);
    expect(uiSessionEventMatches({ ...host, sessionKey }, key, "unrelated")).toBe(false);
  },
);

it.each([
  ["  agent:main:dashboard:p  ", "agent:main:controller", "agent:main:dashboard:p"],
  ["  \t  ", "  agent:main:controller  ", "agent:main:controller"],
  [null, "  ", undefined],
])("resolves the first non-empty parent %j", (parentSessionKey, spawnedBy, expected) => {
  expect(resolveUiSessionNavigationParentKey({ parentSessionKey, spawnedBy })).toBe(expected);
});

function identityHost(
  sessionKey: string,
  defaultId = "main",
  mainKey = "main",
  scope = "per-sender",
) {
  return { agentsList: { defaultId, mainKey, scope }, assistantAgentId: "main", sessionKey };
}

it("distinguishes targeted events from unscoped broadcasts", () => {
  const host = identityHost("agent:main:main");
  for (const [key, agent, expected] of [
    ["global", "main", false],
    ["agent:main:main", "work", false],
    [undefined, "work", true],
    [null, "work", true],
    ["", "work", true],
  ] as const) {
    expect(uiSessionEventMatches(host, key, agent)).toBe(expected);
  }
  expect(uiSessionRowMatchesSelectedChat(host, "global", host.sessionKey)).toBe(false);
});

it("uses configured main aliases in events, rows and persistence", () => {
  const host = identityHost("agent:ops:home", "ops", "home");
  for (const key of ["main", "agent:ops:main"]) {
    expect(uiSessionEventMatches(host, key)).toBe(true);
    expect(canonicalUiSessionKeyForPersistence(host, key)).toBe(host.sessionKey);
  }
  expect(uiSessionRowMatchesSelectedChat(host, "main", host.sessionKey)).toBe(true);
  expect(uiSessionRowMatchesSelectedChat(host, "global", host.sessionKey)).toBe(false);
  for (const key of ["agent:ops:home", "agent:ops:main", "agent:ops:other"]) {
    expect(isUiSelectedGlobalSessionKey(host, key)).toBe(false);
  }
});

it("keeps global events scoped to the selected agent", () => {
  const host = identityHost("agent:work:main", "main", "main", "global");
  expect(uiSessionEventMatches(host, "global", "work")).toBe(true);
  expect(uiSessionEventMatches(host, "global", "main")).toBe(false);
  expect(uiSessionEventMatches(host, "agent:main:main")).toBe(false);
});

const pinRow = (key: string, parentSessionKey?: string, spawnedBy?: string) => ({
  key: `agent:${key}`,
  parentSessionKey,
  spawnedBy,
});
const mainRoot = "agent:main:main";
it.each([
  [pinRow("main:dashboard:ordinary"), true],
  [pinRow("main:dashboard:ordinary", mainRoot), true],
  [pinRow("other:dashboard:ordinary", mainRoot), false],
  [pinRow("main:dashboard:spawned", mainRoot, mainRoot), false],
  [pinRow("main:subagent:spawned", mainRoot), false],
])("projects pin eligibility for %j", (row, expected) => {
  expect(isPinnableUiSessionRow(row)).toBe(expected);
});
