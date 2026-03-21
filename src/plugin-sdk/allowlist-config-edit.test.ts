import { describe, expect, it } from "vitest";
import {
  buildDmGroupAccountAllowlistAdapter,
  buildLegacyDmAccountAllowlistAdapter,
  collectAllowlistOverridesFromRecord,
  collectNestedAllowlistOverridesFromRecord,
  createAccountScopedAllowlistNameResolver,
  createFlatAllowlistOverrideResolver,
  createNestedAllowlistOverrideResolver,
  readConfiguredAllowlistEntries,
} from "./allowlist-config-edit.js";

describe("readConfiguredAllowlistEntries", () => {
  it("coerces mixed entries to non-empty strings", () => {
    expect(readConfiguredAllowlistEntries(["owner", 42, ""])).toEqual(["owner", "42"]);
  });
});

describe("collectAllowlistOverridesFromRecord", () => {
  it("collects only non-empty overrides from a flat record", () => {
    expect(
      collectAllowlistOverridesFromRecord({
        record: {
          room1: { users: ["a", "b"] },
          room2: { users: [] },
        },
        label: (key) => key,
        resolveEntries: (value) => value.users,
      }),
    ).toEqual([{ label: "room1", entries: ["a", "b"] }]);
  });
});

describe("collectNestedAllowlistOverridesFromRecord", () => {
  it("collects outer and nested overrides from a hierarchical record", () => {
    expect(
      collectNestedAllowlistOverridesFromRecord({
        record: {
          guild1: {
            users: ["owner"],
            channels: {
              chan1: { users: ["member"] },
            },
          },
        },
        outerLabel: (key) => `guild ${key}`,
        resolveOuterEntries: (value) => value.users,
        resolveChildren: (value) => value.channels,
        innerLabel: (outerKey, innerKey) => `guild ${outerKey} / channel ${innerKey}`,
        resolveInnerEntries: (value) => value.users,
      }),
    ).toEqual([
      { label: "guild guild1", entries: ["owner"] },
      { label: "guild guild1 / channel chan1", entries: ["member"] },
    ]);
  });
});

describe("createFlatAllowlistOverrideResolver", () => {
  it("builds an account-scoped flat override resolver", () => {
    const resolveOverrides = createFlatAllowlistOverrideResolver({
      resolveRecord: (account: { channels?: Record<string, { users: string[] }> }) =>
        account.channels,
      label: (key) => key,
      resolveEntries: (value) => value.users,
    });

    expect(resolveOverrides({ channels: { room1: { users: ["a"] } } })).toEqual([
      { label: "room1", entries: ["a"] },
    ]);
  });
});

describe("createNestedAllowlistOverrideResolver", () => {
  it("builds an account-scoped nested override resolver", () => {
    const resolveOverrides = createNestedAllowlistOverrideResolver({
      resolveRecord: (account: {
        groups?: Record<
          string,
          { allowFrom?: string[]; topics?: Record<string, { allowFrom?: string[] }> }
        >;
      }) => account.groups,
      outerLabel: (groupId) => groupId,
      resolveOuterEntries: (group) => group.allowFrom,
      resolveChildren: (group) => group.topics,
      innerLabel: (groupId, topicId) => `${groupId} topic ${topicId}`,
      resolveInnerEntries: (topic) => topic.allowFrom,
    });

    expect(
      resolveOverrides({
        groups: {
          g1: { allowFrom: ["owner"], topics: { t1: { allowFrom: ["member"] } } },
        },
      }),
    ).toEqual([
      { label: "g1", entries: ["owner"] },
      { label: "g1 topic t1", entries: ["member"] },
    ]);
  });
});

describe("createAccountScopedAllowlistNameResolver", () => {
  it("returns empty results when the resolved account has no token", async () => {
    const resolveNames = createAccountScopedAllowlistNameResolver({
      resolveAccount: () => ({ token: "" }),
      resolveToken: (account) => account.token,
      resolveNames: async ({ token, entries }) =>
        entries.map((entry) => ({ input: `${token}:${entry}`, resolved: true })),
    });

    expect(await resolveNames({ cfg: {}, accountId: "alt", scope: "dm", entries: ["a"] })).toEqual(
      [],
    );
  });

  it("delegates to the resolver when a token is present", async () => {
    const resolveNames = createAccountScopedAllowlistNameResolver({
      resolveAccount: () => ({ token: " secret " }),
      resolveToken: (account) => account.token,
      resolveNames: async ({ token, entries }) =>
        entries.map((entry) => ({ input: entry, resolved: true, name: `${token}:${entry}` })),
    });

    expect(await resolveNames({ cfg: {}, accountId: "alt", scope: "dm", entries: ["a"] })).toEqual([
      { input: "a", resolved: true, name: "secret:a" },
    ]);
  });
});

describe("buildDmGroupAccountAllowlistAdapter", () => {
  const adapter = buildDmGroupAccountAllowlistAdapter({
    channelId: "demo",
    resolveAccount: ({ accountId }) => ({
      accountId: accountId ?? "default",
      dmAllowFrom: ["dm-owner"],
      groupAllowFrom: ["group-owner"],
      dmPolicy: "allowlist",
      groupPolicy: "allowlist",
      groupOverrides: [{ label: "room-1", entries: ["member-1"] }],
    }),
    normalize: ({ values }) => values.map((entry) => String(entry).trim().toLowerCase()),
    resolveDmAllowFrom: (account) => account.dmAllowFrom,
    resolveGroupAllowFrom: (account) => account.groupAllowFrom,
    resolveDmPolicy: (account) => account.dmPolicy,
    resolveGroupPolicy: (account) => account.groupPolicy,
    resolveGroupOverrides: (account) => account.groupOverrides,
  });

  it("supports dm, group, and all scopes", () => {
    expect(adapter.supportsScope?.({ scope: "dm" })).toBe(true);
    expect(adapter.supportsScope?.({ scope: "group" })).toBe(true);
    expect(adapter.supportsScope?.({ scope: "all" })).toBe(true);
  });

  it("reads dm/group config from the resolved account", () => {
    expect(adapter.readConfig?.({ cfg: {}, accountId: "alt" })).toEqual({
      dmAllowFrom: ["dm-owner"],
      groupAllowFrom: ["group-owner"],
      dmPolicy: "allowlist",
      groupPolicy: "allowlist",
      groupOverrides: [{ label: "room-1", entries: ["member-1"] }],
    });
  });

  it("writes group allowlist entries to groupAllowFrom", () => {
    expect(
      adapter.applyConfigEdit?.({
        cfg: {},
        parsedConfig: {},
        accountId: "alt",
        scope: "group",
        action: "add",
        entry: " Member-2 ",
      }),
    ).toEqual({
      kind: "ok",
      changed: true,
      pathLabel: "channels.demo.accounts.alt.groupAllowFrom",
      writeTarget: {
        kind: "account",
        scope: { channelId: "demo", accountId: "alt" },
      },
    });
  });
});

describe("buildLegacyDmAccountAllowlistAdapter", () => {
  const adapter = buildLegacyDmAccountAllowlistAdapter({
    channelId: "demo",
    resolveAccount: ({ accountId }) => ({
      accountId: accountId ?? "default",
      dmAllowFrom: ["owner"],
      groupPolicy: "allowlist",
      groupOverrides: [{ label: "group-1", entries: ["member-1"] }],
    }),
    normalize: ({ values }) => values.map((entry) => String(entry).trim().toLowerCase()),
    resolveDmAllowFrom: (account) => account.dmAllowFrom,
    resolveGroupPolicy: (account) => account.groupPolicy,
    resolveGroupOverrides: (account) => account.groupOverrides,
  });

  it("supports only dm scope", () => {
    expect(adapter.supportsScope?.({ scope: "dm" })).toBe(true);
    expect(adapter.supportsScope?.({ scope: "group" })).toBe(false);
    expect(adapter.supportsScope?.({ scope: "all" })).toBe(false);
  });

  it("reads legacy dm config from the resolved account", () => {
    expect(adapter.readConfig?.({ cfg: {}, accountId: "alt" })).toEqual({
      dmAllowFrom: ["owner"],
      groupPolicy: "allowlist",
      groupOverrides: [{ label: "group-1", entries: ["member-1"] }],
    });
  });

  it("writes dm allowlist entries and keeps legacy cleanup behavior", () => {
    expect(
      adapter.applyConfigEdit?.({
        cfg: {},
        parsedConfig: {
          channels: {
            demo: {
              accounts: {
                alt: {
                  dm: { allowFrom: ["owner"] },
                },
              },
            },
          },
        },
        accountId: "alt",
        scope: "dm",
        action: "add",
        entry: "admin",
      }),
    ).toEqual({
      kind: "ok",
      changed: true,
      pathLabel: "channels.demo.accounts.alt.allowFrom",
      writeTarget: {
        kind: "account",
        scope: { channelId: "demo", accountId: "alt" },
      },
    });
  });
});
