import { expect, it } from "vitest";
import type { IdentifierAuthentication } from "./identifier-authentication.js";
import type { ResolveStableChannelMessageIngressParams } from "./runtime-types.js";
import { resolveStableChannelIngressPolicy } from "./runtime.js";

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
  conversation: { kind: "group" as const, id: "room-1" },
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

it("combines each matched entry with the exact same-kind subject identifier", async () => {
  const identity = emailIdentity("verified", "secondary-email", "verified");
  const subject = {
    stableId: "strong@example.test",
    aliases: { "secondary-email": "weak@example.test" },
    authentication: {
      "primary-email": "verified" as const,
      "secondary-email": "unverified" as const,
    },
  };

  const resolveEntry = (value: string) =>
    resolve({
      identity,
      subject,
      allowFrom: [value],
      policy: { minIdentifierAuthentication: "verified" },
    });
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
    policy: { minIdentifierAuthentication: "verified" },
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
        stableId: "sender-1",
        aliases: { alias: "alias-1" },
        authentication: { stableId: "verified" },
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
      policy: { minIdentifierAuthentication: "verified" },
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
    policy: { minIdentifierAuthentication: "verified" },
  });

  expect(result.senderAccess).toMatchObject(denied);
});

it.each([
  {
    name: "group sender",
    patch: {
      conversation: { kind: "group" as const, id: "room-1" },
      allowFrom: [],
      groupAllowFrom: ["sender-1"],
    },
    check: (result: Result) => result.senderAccess.allowed,
  },
  {
    name: "command owner",
    patch: {
      command: {
        allowTextCommands: true,
        hasControlCommand: true,
        commandOwnerAllowFrom: ["sender-1"],
      },
    },
    check: (result: Result) => result.commandAccess.authorized,
  },
  {
    name: "route sender",
    patch: {
      ...inheritedRoute,
      route: { ...inheritedRoute.route, senderPolicy: "replace" as const },
    },
    check: (result: Result) => result.routeAccess.allowed && result.senderAccess.allowed,
  },
])("applies the exact-pair threshold to $name gates", async ({ patch, check }) => {
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
    policy: { minIdentifierAuthentication: "verified" },
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
    policy: { minIdentifierAuthentication: "verified" },
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

it.each([
  {
    name: "runtime resolver",
    patch: {
      resolveAccessGroupMembership: async () => true,
    },
  },
  {
    name: "precomputed membership",
    patch: {
      accessGroupMembership: [
        {
          kind: "matched" as const,
          groupName: "audience",
          source: "dynamic" as const,
          matchedEntryIds: ["access-group:audience"],
        },
      ],
    },
  },
])("fails $name access-group matches closed at a verified minimum", async ({ patch }) => {
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
    policy: { minIdentifierAuthentication: "verified" },
  });

  expectThresholdDenied(result);
});
