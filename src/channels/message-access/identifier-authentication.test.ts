import { expect, it } from "vitest";
import { decideChannelIngress } from "./decision.js";
import type { IdentifierAuthentication } from "./identifier-authentication.js";
import type { ResolveStableChannelMessageIngressParams } from "./runtime-types.js";
import { resolveStableChannelIngressPolicy } from "./runtime.js";
import { resolveChannelIngressState } from "./state.js";
import type { InternalChannelIngressAdapter } from "./types.js";

type Input = Partial<ResolveStableChannelMessageIngressParams>;

function resolve(overrides: Input) {
  return resolveStableChannelIngressPolicy({
    channelId: "test",
    accountId: "default",
    subject: { stableId: "sender-1" },
    conversation: { kind: "direct", id: "dm-1" },
    dmPolicy: "allowlist",
    groupPolicy: "allowlist",
    allowFrom: ["sender-1"],
    ...overrides,
  });
}
const resolveVerified = (overrides: Input) =>
  resolve({
    identity: { authentication: "verified" },
    subject: { stableId: "sender-1", authentication: { stableId: "unverified" } },
    policy: { minIdentifierAuthentication: "verified" },
    ...overrides,
  });
const verifiedPolicy = { minIdentifierAuthentication: "verified" } as const;
const groupConversation = { kind: "group", id: "room-1" } as const;

function emailIdentity(
  authentication?: IdentifierAuthentication,
  alias = "alias-email",
  aliasAuthentication?: IdentifierAuthentication,
) {
  return {
    key: "primary-email",
    kind: "email" as const,
    authentication,
    aliases: [{ key: alias, kind: "email" as const, authentication: aliasAuthentication }],
  };
}
const claimed = (stableId: string, field: string, strength: IdentifierAuthentication) => ({
  stableId,
  authentication: { [field]: strength },
});
const inheritedRoute = {
  conversation: groupConversation,
  allowFrom: [],
  groupAllowFrom: ["other"],
  route: { id: "route-1", senderPolicy: "inherit" as const, senderAllowFrom: ["sender-1"] },
};
function originEvent(opaqueId: string, kind: "email" | "stable-id", value: string) {
  return {
    kind: "reaction" as const,
    authMode: "origin-subject" as const,
    mayPair: false,
    originSubject: {
      identifiers: [{ opaqueId, kind, value, authentication: "verified" as const }],
    },
  };
}
type Result = Awaited<ReturnType<typeof resolve>>;
const denied = { allowed: false, reasonCode: "dm_policy_not_allowlisted" };
const originDenied = { admission: "drop", reasonCode: "origin_subject_not_matched" };
function expectThresholdDenied(result: Result, reasonCode = "dm_policy_not_allowlisted") {
  expect(result.senderAccess).toMatchObject({
    allowed: false,
    reasonCode,
    gate: { identifierAuthentication: { evaluated: true, affectedMatch: true } },
  });
}

it.each(["inbound", "origin-subject"] as const)(
  "preserves static authentication for legacy %s adapters without matched pairs",
  async (authMode) => {
    const adapter: InternalChannelIngressAdapter = {
      normalizeEntries: ({ entries }) => ({
        matchable: entries.map((value, index) => ({
          opaqueEntryId: `entry-${index}`,
          kind: "stable-id",
          value: value.toLowerCase(),
        })),
        invalid: [],
        disabled: [],
      }),
      matchSubject: ({ subject, entries }) => {
        const values = new Set(subject.identifiers.map(({ value }) => value.toLowerCase()));
        const matchedEntryIds = entries
          .filter(({ value }) => values.has(value))
          .map(({ opaqueEntryId }) => opaqueEntryId);
        return { matched: matchedEntryIds.length > 0, matchedEntryIds };
      },
    };
    const state = await resolveChannelIngressState({
      channelId: "test",
      accountId: "default",
      adapter,
      subject: { identifiers: [{ opaqueId: "sender", kind: "stable-id", value: "SENDER" }] },
      conversation: { kind: "direct", id: "dm-1" },
      allowlists: { dm: ["sender"] },
      event: {
        kind: "message",
        authMode,
        mayPair: false,
        originSubject: {
          identifiers: [{ opaqueId: "sender", kind: "stable-id", value: "sender" }],
        },
      },
    });
    const policy = { dmPolicy: "allowlist", groupPolicy: "allowlist" } as const;
    expect(decideChannelIngress(state, policy).admission).toBe("dispatch");
    expect(decideChannelIngress(state, { ...policy, ...verifiedPolicy }).admission).toBe("drop");
  },
);

it("combines each matched entry with the exact same-kind subject identifier", async () => {
  const input = {
    identity: emailIdentity("verified", "secondary-email", "verified"),
    subject: {
      stableId: "strong@example.test",
      aliases: { "secondary-email": "weak@example.test" },
      authentication: { "primary-email": "verified", "secondary-email": "unverified" },
    },
    policy: verifiedPolicy,
  } satisfies Input;
  const resolveEntry = (value: string) => resolve({ ...input, allowFrom: [value] });
  const strong = await resolveEntry("strong@example.test");
  const weak = await resolveEntry("weak@example.test");

  expect(strong.senderAccess.allowed).toBe(true);
  expect(weak.senderAccess).toMatchObject(denied);
  expect(strong.state.allowlists.dm.match.matchedPairs).toMatchObject([
    { opaqueSubjectId: "primary-email", subjectAuthentication: "verified" },
  ]);
  expect(JSON.stringify(strong.state)).not.toContain("strong@example.test");
  expect(JSON.stringify(weak.state)).not.toContain("weak@example.test");
});

it("does not cross-bind same-kind authentication between identity fields", async () => {
  const result = await resolve({
    identity: emailIdentity("asserted", "alias-email", "verified"),
    subject: claimed("shared@example.test", "primary-email", "asserted"),
    allowFrom: ["shared@example.test"],
    policy: verifiedPolicy,
  });

  expect(result.senderAccess).toMatchObject(denied);
  expect(result.state.allowlists.dm.match.matchedPairs).not.toContainEqual(
    expect.objectContaining({
      opaqueEntryId: "entry-1:alias-email",
      opaqueSubjectId: "primary-email",
    }),
  );
  expect(JSON.stringify(result.state)).not.toContain("shared@example.test");
});

it("preserves the shipped dangerous and mutableIdentifierMatching mappings", async () => {
  const params: Input = {
    identity: { dangerous: true },
    subject: { stableId: "display-name" },
    allowFrom: ["display-name"],
  };
  const disabled = await resolve(params);
  const enabled = await resolve({
    ...params,
    policy: { mutableIdentifierMatching: "enabled" },
  });

  expect(disabled.senderAccess.allowed).toBe(false);
  expect(disabled.senderAccess.gate?.allowlist?.disabledEntryCount).toBeGreaterThan(0);
  expect(enabled.senderAccess.allowed).toBe(true);
});

it.each<[string, Input, boolean, string, string]>([
  [
    "floors a missing alias claim",
    {
      identity: {
        authentication: "verified",
        aliases: [{ key: "alias", authentication: "verified" }],
      },
      subject: {
        ...claimed("sender-1", "stableId", "verified"),
        aliases: { alias: "alias-1" },
      },
      allowFrom: ["alias-1"],
    },
    false,
    "alias",
    "unverified",
  ],
  [
    "preserves static strength without a claim map",
    {
      identity: { authentication: "verified" },
      policy: verifiedPolicy,
    },
    true,
    "stableId",
    "verified",
  ],
])("%s", async (_name, input, allowed, field, strength) => {
  const result = await resolve(input);
  expect(result.senderAccess.allowed).toBe(allowed);
  expect(result.state.allowlists.dm.match.matchedPairs).toEqual([
    {
      opaqueEntryId: `entry-1:${field}`,
      opaqueSubjectId: field,
      subjectAuthentication: strength,
    },
  ]);
});

it.each(["disabled", "enabled"] as const)(
  "keeps mutable alias matching %s with only the primary claim supplied",
  async (mutableIdentifierMatching) => {
    const result = await resolve({
      identity: {
        key: "member-id",
        aliases: [{ key: "display-name", kind: "username", dangerous: true }],
      },
      subject: {
        stableId: "member-1",
        aliases: { "display-name": "Echo" },
        authentication: { "member-id": "asserted" },
      },
      allowFrom: ["Echo"],
      policy: { mutableIdentifierMatching },
    });

    expect(result.senderAccess.allowed).toBe(mutableIdentifierMatching === "enabled");
  },
);

it("does not let a wildcard without an exact primary identifier claim verified", async () => {
  const result = await resolve({
    identity: { authentication: "verified" },
    subject: {},
    allowFrom: ["*"],
    policy: verifiedPolicy,
  });

  expect(result.senderAccess).toMatchObject(denied);
});

it.each<[string, Input, (result: Result) => boolean]>([
  [
    "group sender",
    { conversation: groupConversation, allowFrom: [], groupAllowFrom: ["sender-1"] },
    (result) => result.senderAccess.allowed,
  ],
  [
    "command owner",
    {
      command: {
        allowTextCommands: true,
        hasControlCommand: true,
        commandOwnerAllowFrom: ["sender-1"],
      },
    },
    (result) => result.commandAccess.authorized,
  ],
  [
    "route sender",
    {
      ...inheritedRoute,
      route: { ...inheritedRoute.route, senderPolicy: "replace" },
    },
    (result) => result.routeAccess.allowed && result.senderAccess.allowed,
  ],
])("applies the exact-pair threshold to %s gates", async (_name, patch, check) => {
  const result = await resolveVerified(patch);
  expect(check(result)).toBe(false);
});

it("preserves exact-pair authentication through inherited route lists", async () => {
  const result = await resolveVerified(inheritedRoute);

  expect(result.routeAccess.allowed).toBe(true);
  expectThresholdDenied(result, "group_policy_not_allowlisted");
  expect(JSON.stringify(result.state)).not.toContain("sender-1");
});

it("namespaces exact pairs from inherited route lists", async () => {
  const result = await resolve({
    ...inheritedRoute,
    identity: {
      authentication: (value) => (value === "sender-1" ? "verified" : "asserted"),
    },
    subject: claimed("sender-1", "stableId", "verified"),
    policy: verifiedPolicy,
  });

  expect(result.senderAccess).toMatchObject({
    allowed: true,
    reasonCode: "group_policy_allowed",
  });
  expect(result.senderAccess.gate?.match?.matchedEntryIds).toEqual(["source-2:entry-1:stableId"]);
});

it("does not cross-bind same-kind origin-subject fields", async () => {
  const result = await resolve({
    identity: emailIdentity(),
    subject: claimed("shared@example.test", "primary-email", "verified"),
    event: originEvent("alias-email", "email", "shared@example.test"),
    policy: verifiedPolicy,
  });

  expect(result.ingress).toMatchObject(originDenied);
  expect(JSON.stringify(result.state)).not.toContain("shared@example.test");
});

it("applies the threshold to access-group and origin-subject gates", async () => {
  const accessGroup = await resolveVerified({
    allowFrom: ["accessGroup:operators"],
    accessGroups: {
      operators: { type: "message.senders", members: { test: ["sender-1"] } },
    },
  });
  const origin = await resolveVerified({
    event: originEvent("origin-stable", "stable-id", "sender-1"),
  });

  expect(accessGroup.senderAccess.allowed).toBe(false);
  expect(origin.ingress).toMatchObject(originDenied);
});

it.each<[string, Input]>([
  ["runtime resolver", { resolveAccessGroupMembership: async () => true }],
  [
    "precomputed membership",
    {
      accessGroupMembership: [
        {
          kind: "matched",
          groupName: "audience",
          source: "dynamic",
          matchedEntryIds: ["access-group:audience"],
        },
      ],
    },
  ],
])("fails %s access-group matches closed at a verified minimum", async (_name, patch) => {
  const result = await resolve({
    ...patch,
    allowFrom: ["accessGroup:audience"],
    accessGroups: {
      audience: {
        type: "discord.channelAudience",
        guildId: "guild-1",
        channelId: "channel-1",
      },
    },
    policy: verifiedPolicy,
  });

  expectThresholdDenied(result);
});

it.each<[string, Input, Input, string]>([
  [
    "pairing-store entries stay DM-policy scoped",
    { allowFrom: [], readStoreAllowFrom: async () => ["sender-1"], dmPolicy: "open" },
    { dmPolicy: "pairing" },
    "dm_policy_not_allowlisted",
  ],
  [
    "group fallback requires opt-in",
    { conversation: groupConversation },
    { policy: { groupAllowFromFallbackToAllowFrom: true } },
    "group_policy_empty_allowlist",
  ],
])("%s", async (_name, input, enabled, reasonCode) => {
  expect((await resolve(input)).ingress).toMatchObject({ admission: "drop", reasonCode });
  expect((await resolve({ ...input, ...enabled })).ingress).toMatchObject({
    admission: "dispatch",
    decision: "allow",
  });
});

it("applies route sender overrides without retaining raw identities", async () => {
  const rawSender = "route-sender@example.test";
  const { state, ingress } = await resolve({
    conversation: groupConversation,
    subject: { stableId: rawSender },
    groupAllowFrom: ["group-sender"],
    route: { id: "space-1", senderPolicy: "replace", senderAllowFrom: [rawSender] },
  });
  expect(state.routeFacts[0]?.senderAllowlist).toMatchObject({
    hasConfiguredEntries: true,
    match: { matched: true },
  });
  expect(ingress).toMatchObject({ admission: "dispatch", decision: "allow" });
  expect(JSON.stringify(state)).not.toContain(rawSender);
  expect(JSON.stringify(ingress)).not.toContain(rawSender);
});

it("blocks matched routes with deny-when-empty sender policy", async () => {
  const { state, ingress } = await resolve({
    route: { id: "space-1", senderPolicy: "deny-when-empty", senderAllowFrom: [] },
  });
  expect(ingress).toMatchObject({ admission: "drop", reasonCode: "route_sender_empty" });
  expect(state.routeFacts[0]).not.toHaveProperty("senderAllowFrom");
});

it("translates implicit mention config before shared activation evaluation", async () => {
  const { ingress } = await resolve({
    conversation: groupConversation,
    groupAllowFrom: ["sender-1"],
    mentionFacts: {
      canDetectMention: true,
      wasMentioned: false,
      implicitMentionKinds: ["reply_to_bot", "bot_thread_participant"],
    },
    policy: {
      activation: {
        requireMention: true,
        allowTextCommands: false,
        implicitMentions: { replyToBot: false, quotedBot: true, threadParticipation: true },
      },
    },
  });
  expect(ingress).toMatchObject({ admission: "dispatch", decision: "allow" });
  expect(ingress.graph.gates.find((gate) => gate.phase === "activation")?.activation).toMatchObject(
    {
      allowedImplicitMentionKinds: ["quoted_bot", "bot_thread_participant", "native"],
      effectiveWasMentioned: true,
    },
  );
});

it.each([
  ["same", "sender-1", "sender-1", false, true],
  ["different", "sender-1", "different-sender", false, false],
  ["normalized", "Sender-1", "sender-1", true, true],
] as const)("matches %s origin actors", async (_name, current, origin, foldCase, matched) => {
  const { state, ingress } = await resolve({
    allowFrom: [],
    subject: { stableId: current },
    identity: foldCase ? { normalize: (value) => value.toLowerCase() } : undefined,
    event: originEvent("stableId", "stable-id", origin),
  });
  expect(state.event.originSubjectMatched).toBe(matched);
  expect(ingress).toMatchObject(
    matched
      ? { admission: "dispatch", decision: "allow" }
      : { admission: "drop", decision: "block", reasonCode: "origin_subject_not_matched" },
  );
  if (matched) {
    expect(
      ingress.graph.gates.find((gate) => gate.phase === "sender" && gate.kind === "dmSender"),
    ).toMatchObject({
      effect: "ignore",
      reasonCode: "sender_not_required",
    });
  }
});
