import * as stringCoerce from "@openclaw/normalization-core/string-coerce";
// @vitest-environment node
import { parseAgentSessionKeyParts } from "@openclaw/session-url-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
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

describe("Dashboard fixture session keys", () => {
  it.each([
    ["agent:main:main", "main", "main", "main"],
    [
      "agent:data-expert:dingtalk:cidzg6sF43NZMy52Rnk8EN",
      "data-expert",
      "dingtalk:cidzg6sF43NZMy52Rnk8EN",
      "dingtalk:cidzg6sf43nzmy52rnk8en",
    ],
    ["main", null, null, null],
    ["agent::secret", null, null, null],
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
});

describe("session archive eligibility", () => {
  it.each([
    ["active non-main", [{ key: "agent:main:work", hasActiveRun: true }], true, false],
    ["idle non-main", [{ key: "agent:main:work" }], true, true],
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
});

describe("parseSessionKeyParts", () => {
  it.each([
    [
      "agent:data-expert:dingtalk:cidzg6sF43NZMy52Rnk8EN",
      { agentId: "data-expert", channel: "dingtalk", accountId: "cidzg6sF43NZMy52Rnk8EN" },
    ],
    [
      "agent:main:telegram:user:12345:extra",
      { agentId: "main", channel: "telegram", accountId: "user:12345:extra" },
    ],
    ["Agent:main:telegram:user", null],
  ] as const)("parses opaque channel accounts in %j", (key, expected) => {
    expect(parseSessionKeyParts(key)).toEqual(expected);
  });
});

describe("UI session identity", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([undefined, " \t\n", "main"])(
    "preserves nonblank equivalence for identical %j inputs",
    (key) => expect(areUiSessionKeysEquivalent(key, key)).toBe(Boolean(key?.trim())),
  );

  it("reuses comparison keys until bounded eviction without changing their identities", () => {
    const normalize = vi.spyOn(stringCoerce, "normalizeOptionalString");
    const keys = [
      [
        " Agent:Cache:Matrix:Channel:!Room:Example.Org ",
        "agent:cache:matrix:channel:!Room:Example.Org",
      ],
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
    [" Agent:OPS:Telegram:Direct:ABC ", "agent:ops:telegram:direct:abc"],
    [" \t\n", ""],
    [
      "Agent:Ops:Catalog:Fixture:Node%3ADevBox:Thread%3AA",
      "agent:ops:Catalog:Fixture:Node%3ADevBox:Thread%3AA",
    ],
    ["agent:ops:other:signal:group:AbC", "agent:ops:other:signal:group:abc"],
    ["agent:ops:signal:group:AbC:signal:group:DeF", "agent:ops:signal:group:AbC:signal:group:def"],
    [":Matrix:Channel:!Room:Org", ":matrix:channel:!Room:Org"],
    ["agent:ops: :Matrix:Channel:!Room:Org", "agent:ops: :matrix:channel:!Room:Org"],
    [
      "agent:ops:matrix:channel: !Room:Org :thread:$Event",
      "agent:ops:matrix:channel: !Room:Org :thread:$Event",
    ],
  ])("retains UI comparison normalization for %s", (key, expected) => {
    expect(normalizeSessionKeyForUiComparison(key)).toBe(expected);
  });

  it.each([
    {
      name: "native catalog source IDs",
      selectedKey: "agent:ops:catalog:fixture:node%3ADevBox:Thread%3AA",
      structuralAlias: "Agent:Ops:catalog:fixture:node%3ADevBox:Thread%3AA",
      distinctKey: "agent:ops:catalog:fixture:node%3ADevBox:thread%3Aa",
    },
    {
      name: "Matrix room IDs",
      selectedKey: "agent:ops:matrix:channel:!Room:Example.Org",
      structuralAlias: "Agent:Ops:Matrix:Channel:!Room:Example.Org",
      distinctKey: "agent:ops:matrix:channel:!room:example.org",
    },
    {
      name: "Matrix room and thread IDs",
      selectedKey: "agent:ops:matrix:channel:!Room:Example.Org:thread:$Event",
      structuralAlias: "Agent:Ops:Matrix:Channel:!Room:Example.Org:Thread:$Event",
      distinctKey: "agent:ops:matrix:channel:!Room:Example.Org:thread:$event",
    },
    {
      name: "Signal group IDs",
      selectedKey: "agent:ops:signal:group:AbC123=",
      structuralAlias: "Agent:Ops:Signal:Group:AbC123=",
      distinctKey: "agent:ops:signal:group:abc123=",
    },
    {
      name: "Signal group IDs with normalized thread suffixes",
      selectedKey: "agent:ops:signal:group:AbC123=:thread:xyz",
      structuralAlias: "Agent:Ops:Signal:Group:AbC123=:Thread:XyZ",
      distinctKey: "agent:ops:signal:group:abc123=:thread:xyz",
    },
  ])(
    "preserves $name in live events and persisted session identity",
    ({ selectedKey, structuralAlias, distinctKey }) => {
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
    },
  );

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
        hello: {
          snapshot: {
            sessionDefaults: {
              defaultAgentId: "ops",
              mainKey: "home",
              mainSessionKey: "agent:ops:current",
            },
          },
        },
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
    {
      parentSessionKey: "  agent:main:dashboard:navigation-parent  ",
      spawnedBy: "agent:main:controller",
      expected: "agent:main:dashboard:navigation-parent",
    },
    {
      parentSessionKey: "  \t  ",
      spawnedBy: "  agent:main:controller  ",
      expected: "agent:main:controller",
    },
    { parentSessionKey: null, spawnedBy: "  ", expected: undefined },
  ])("resolves the first non-empty navigation parent", ({ expected, ...row }) => {
    expect(resolveUiSessionNavigationParentKey(row)).toBe(expected);
  });
});

describe("canonical host-scoped event and row matching", () => {
  it.each([
    {
      scope: "per-sender",
      defaultId: "main",
      mainKey: "main",
      sessionKey: "agent:main:main",
      events: [
        ["global", "main", false],
        ["agent:main:main", "work", false],
        [undefined, "work", true],
        [null, "work", true],
        ["", "work", true],
      ],
      rows: [["global", false]],
      aliases: [],
      nonGlobal: [],
    },
    {
      scope: "per-sender",
      defaultId: "ops",
      mainKey: "home",
      sessionKey: "agent:ops:home",
      events: [
        ["main", undefined, true],
        ["agent:ops:main", undefined, true],
      ],
      rows: [
        ["main", true],
        ["global", false],
      ],
      aliases: ["main", "agent:ops:main"],
      nonGlobal: ["agent:ops:home", "agent:ops:main", "agent:ops:other"],
    },
    {
      scope: "global",
      defaultId: "main",
      mainKey: "main",
      sessionKey: "agent:work:main",
      events: [
        ["global", "work", true],
        ["global", "main", false],
        ["agent:main:main", undefined, false],
      ],
      rows: [],
      aliases: [],
      nonGlobal: [],
    },
  ] as const)(
    "matches $scope identities for $sessionKey",
    ({ scope, defaultId, mainKey, sessionKey, events, rows, aliases, nonGlobal }) => {
      const host = {
        agentsList: { defaultId, mainKey, scope },
        assistantAgentId: "main",
        sessionKey,
      };
      for (const [key, agentId, expected] of events) {
        expect(uiSessionEventMatches(host, key, agentId)).toBe(expected);
      }
      for (const [key, expected] of rows) {
        expect(uiSessionRowMatchesSelectedChat(host, key, sessionKey)).toBe(expected);
      }
      for (const key of aliases) {
        expect(canonicalUiSessionKeyForPersistence(host, key)).toBe(sessionKey);
      }
      for (const key of nonGlobal) {
        expect(isUiSelectedGlobalSessionKey(host, key)).toBe(false);
      }
    },
  );
});

describe("session pin eligibility", () => {
  it.each([
    [{ key: "agent:main:dashboard:ordinary" }, true],
    [{ key: "agent:main:dashboard:ordinary", parentSessionKey: "agent:main:main" }, true],
    [{ key: "agent:other:dashboard:ordinary", parentSessionKey: "agent:other:main" }, true],
    [{ key: "agent:other:dashboard:ordinary", parentSessionKey: "agent:main:main" }, false],
    [
      { key: "agent:main:dashboard:nested", parentSessionKey: "agent:main:dashboard:parent" },
      false,
    ],
    [
      {
        key: "agent:main:dashboard:spawned",
        parentSessionKey: "agent:main:main",
        spawnedBy: "agent:main:main",
      },
      false,
    ],
    [{ key: "agent:main:subagent:spawned", parentSessionKey: "agent:main:main" }, false],
  ])("projects pin eligibility for %j", (row, expected) => {
    expect(isPinnableUiSessionRow(row)).toBe(expected);
  });
});
