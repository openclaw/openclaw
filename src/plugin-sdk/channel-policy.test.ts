import { describe, expect, it } from "vitest";
import { formatPairingApproveHint } from "../channels/plugins/helpers.js";
import type { GroupPolicy } from "../config/types.base.js";
import {
  buildMutableAllowEntryDetector,
  collectStandardAllowlistLists,
  coerceNativeSetting,
  createDangerousNameMatchingMutableAllowlistWarningCollector,
  createRestrictSendersChannelSecurity,
  evaluateGroupRouteAccessForPolicy,
  evaluateSenderGroupAccessForPolicy,
  normalizeAllowFromList,
  resolveSenderScopedGroupPolicy,
} from "./channel-policy.js";

describe("retained group policy helpers", () => {
  it.each([
    ["disabled", ["a"], "disabled"],
    ["allowlist", ["a"], "allowlist"],
    ["allowlist", [], "open"],
  ] as const)("resolves %s with senders %j to %s", (groupPolicy, groupAllowFrom, expected) => {
    expect(
      resolveSenderScopedGroupPolicy({ groupPolicy, groupAllowFrom: [...groupAllowFrom] }),
    ).toBe(expected);
  });

  it.each([
    ["disabled", ["123"], "disabled"],
    ["allowlist", [], "empty_allowlist"],
  ] as const)("blocks sender policy %s with %j", (groupPolicy, groupAllowFrom, reason) => {
    expect(
      evaluateSenderGroupAccessForPolicy({
        groupPolicy,
        groupAllowFrom: [...groupAllowFrom],
        senderId: "123",
        isSenderAllowed: () => true,
      }),
    ).toEqual({ allowed: false, reason, groupPolicy, providerMissingFallbackApplied: false });
  });

  it.each([
    ["disabled", true, true, true, "disabled"],
    ["allowlist", false, false, undefined, "empty_allowlist"],
    ["allowlist", true, false, undefined, "route_not_allowlisted"],
    ["open", true, true, false, "route_disabled"],
  ] as const)(
    "blocks route %s (%s/%s/%s): %s",
    (groupPolicy, routeAllowlistConfigured, routeMatched, routeEnabled, reason) => {
      expect(
        evaluateGroupRouteAccessForPolicy({
          groupPolicy,
          routeAllowlistConfigured,
          routeMatched,
          routeEnabled,
        }),
      ).toMatchObject({ allowed: false, reason });
    },
  );
});

describe("mutable allowlist table helpers", () => {
  it("collects standard account, DM, and nested group lists in stable order", () => {
    expect(
      collectStandardAllowlistLists(
        {
          prefix: "channels.demo",
          account: {
            allowFrom: ["user"],
            groupAllowFrom: ["group-user"],
            dm: { allowFrom: ["dm-user"] },
            rooms: { general: { users: ["room-user"] } },
          },
        },
        { includeDm: true, includeGroups: true, groupsKey: "rooms", groupField: "users" },
      ),
    ).toEqual([
      { pathLabel: "channels.demo.allowFrom", list: ["user"] },
      { pathLabel: "channels.demo.groupAllowFrom", list: ["group-user"] },
      { pathLabel: "channels.demo.dm.allowFrom", list: ["dm-user"] },
      { pathLabel: "channels.demo.rooms.general.users", list: ["room-user"] },
    ]);
  });

  it("builds a detector from prefixes and a stable-id pattern", () => {
    const detector = buildMutableAllowEntryDetector({
      prefixes: ["", "demo:", "user:"],
      stableIdPattern: /^U\d+$/,
    });
    expect(detector("demo:user:U123")).toBe(false);
    expect(detector("demo:alice")).toBe(true);
    expect(detector("*")).toBe(false);
    expect(detector("accessGroup:operators")).toBe(false);
  });
});

it("createRestrictSendersChannelSecurity builds DM policy and warnings from one descriptor", () => {
  const dmRouting = {
    resolveDmScope: () => "per-peer" as const,
    resolveDmRoute: () => ({ kind: "core" as const }),
  };
  const security = createRestrictSendersChannelSecurity<{
    accountId: string;
    allowFrom?: string[];
    dmPolicy?: string;
    groupPolicy?: GroupPolicy;
  }>({
    channelKey: "line",
    resolveDmPolicy: (account) => account.dmPolicy,
    resolveDmAllowFrom: (account) => account.allowFrom,
    resolveGroupPolicy: (account) => account.groupPolicy,
    surface: "LINE groups",
    openScope: "any member in groups",
    groupPolicyPath: "channels.line.groupPolicy",
    groupAllowFromPath: "channels.line.groupAllowFrom",
    mentionGated: false,
    findingTitle: "LINE security warning",
    policyPathSuffix: "dmPolicy",
    classifyEntryAuthentication: () => "asserted",
    dmRouting,
  });

  expect(security.dmRouting).toBe(dmRouting);

  expect(
    security.resolveDmPolicy?.({
      cfg: { channels: {} },
      accountId: "default",
      account: {
        accountId: "default",
        dmPolicy: "allowlist",
        allowFrom: ["line:user:abc"],
      },
    }),
  ).toEqual({
    policy: "allowlist",
    allowFrom: ["line:user:abc"],
    policyPath: "channels.line.dmPolicy",
    allowFromPath: "channels.line.",
    approveHint: formatPairingApproveHint("line"),
    normalizeEntry: undefined,
    classifyEntryAuthentication: expect.any(Function),
  });

  expect(
    security
      .resolveDmPolicy?.({
        cfg: {},
        accountId: "default",
        account: { accountId: "default" },
      })
      ?.classifyEntryAuthentication?.("line:user:abc"),
  ).toBe("asserted");

  expect(
    security.collectWarnings?.({
      cfg: { channels: { line: {} } },
      accountId: "default",
      account: { accountId: "default", groupPolicy: "open" },
    }),
  ).toEqual([
    {
      checkId: "channels.line.groups.open",
      severity: "warn",
      title: "LINE security warning",
      detail:
        'LINE groups: groupPolicy="open" allows any member in groups to trigger. Set channels.line.groupPolicy="allowlist" + channels.line.groupAllowFrom to restrict senders.',
    },
  ]);
});

describe("createDangerousNameMatchingMutableAllowlistWarningCollector", () => {
  const collectWarnings = createDangerousNameMatchingMutableAllowlistWarningCollector({
    channel: "irc",
    detector: (entry) => !entry.includes("@"),
    collectLists: (scope) => [
      {
        pathLabel: `${scope.prefix}.allowFrom`,
        list: scope.account.allowFrom,
      },
    ],
  });

  it("collects mutable entries while dangerous matching is disabled", () => {
    expect(
      collectWarnings({
        cfg: { channels: { irc: { allowFrom: ["charlie"] } } } as never,
      }),
    ).toEqual([
      "- Found 1 mutable allowlist entry across irc while name matching is disabled by default.",
      "- channels.irc.allowFrom: charlie",
      "- Option A (break-glass): enable channels.irc.dangerouslyAllowNameMatching=true to keep name/email/nick matching.",
      "- Option B (recommended): resolve names/emails/nicks to stable sender IDs and rewrite the allowlist entries.",
    ]);
  });

  it("skips scopes that explicitly allow dangerous name matching", () => {
    expect(
      collectWarnings({
        cfg: {
          channels: { irc: { dangerouslyAllowNameMatching: true, allowFrom: ["charlie"] } },
        } as never,
      }),
    ).toStrictEqual([]);
  });
});

describe("normalizeAllowFromList", () => {
  it("normalizes strings and numbers into trimmed entries", () => {
    expect(normalizeAllowFromList(["  abc ", 42, "", "   "])).toEqual(["abc", "42"]);
  });

  it("returns an empty list for non-arrays", () => {
    expect(normalizeAllowFromList(undefined)).toStrictEqual([]);
    expect(normalizeAllowFromList(null)).toStrictEqual([]);
  });
});

it.each([
  [true, true],
  [false, false],
  ["auto", "auto"],
  ["true", undefined],
  ["on", undefined],
  [1, undefined],
] as const)("coerceNativeSetting(%j) returns %j", (input, expected) => {
  expect(coerceNativeSetting(input)).toBe(expected);
});
