import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  buildDmGroupAccountAllowlistAdapter,
  buildLegacyDmAccountAllowlistAdapter,
  collectAllowlistOverridesFromRecord,
  createAccountScopedAllowlistNameResolver,
  createFlatAllowlistOverrideResolver,
  createNestedAllowlistOverrideResolver,
  readConfiguredAllowlistEntries,
} from "./allowlist-config-edit.js";

describe("allowlist config helpers", () => {
  it("coerces mixed entries to non-empty strings", () => {
    expect(readConfiguredAllowlistEntries(["owner", 42, ""])).toEqual(["owner", "42"]);
  });
  it("collects only non-empty overrides from a flat record", () => {
    expect(
      collectAllowlistOverridesFromRecord({
        record: { room1: { users: ["a", "b"] }, room2: { users: [] } },
        label: (key) => key,
        resolveEntries: (value) => value.users,
      }),
    ).toEqual([{ label: "room1", entries: ["a", "b"] }]);
  });
  it("builds an account-scoped flat override resolver", () => {
    const account = { channels: { room1: { users: ["a"] } } };
    const resolveOverrides = createFlatAllowlistOverrideResolver({
      resolveRecord: (value: typeof account) => value.channels,
      label: (key) => key,
      resolveEntries: (value) => value.users,
    });

    expect(resolveOverrides(account)).toEqual([{ label: "room1", entries: ["a"] }]);
  });
  it("builds an account-scoped nested override resolver", () => {
    const account = {
      groups: { g1: { allowFrom: ["owner"], topics: { t1: { allowFrom: ["member"] } } } },
    };
    const resolveOverrides = createNestedAllowlistOverrideResolver({
      resolveRecord: (value: typeof account) => value.groups,
      outerLabel: (groupId) => groupId,
      resolveOuterEntries: (group) => group.allowFrom,
      resolveChildren: (group) => group.topics,
      innerLabel: (groupId, topicId) => `${groupId} topic ${topicId}`,
      resolveInnerEntries: (topic) => topic.allowFrom,
    });

    expect(resolveOverrides(account)).toEqual([
      { label: "g1", entries: ["owner"] },
      { label: "g1 topic t1", entries: ["member"] },
    ]);
  });
  it.each([
    { token: "", expected: [] },
    {
      token: " secret ",
      expected: [{ input: "a", resolved: true, name: "secret:a" }],
    },
  ])("resolves names only with a nonempty trimmed token: '$token'", async ({ token, expected }) => {
    const resolveNames = createAccountScopedAllowlistNameResolver({
      resolveAccount: () => ({ token }),
      resolveToken: (account) => account.token,
      resolveNames: async ({ token: tokenLocal, entries }) =>
        entries.map((entry) => ({ input: entry, resolved: true, name: `${tokenLocal}:${entry}` })),
    });

    expect(await resolveNames({ cfg: {}, accountId: "alt", scope: "dm", entries: ["a"] })).toEqual(
      expected,
    );
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
  const edit = (
    parsedConfig: Record<string, unknown>,
    action: "add" | "remove",
    entry: string,
    accountId = "alt",
    scope: "dm" | "group" = "dm",
  ) =>
    adapter.applyConfigEdit?.({
      cfg: parsedConfig as OpenClawConfig,
      parsedConfig,
      accountId,
      scope,
      action,
      entry,
    });

  it("supports all scope", () => {
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
    expect(edit({}, "add", " Member-2 ", "alt", "group")).toEqual({
      kind: "ok",
      changed: true,
      pathLabel: "channels.demo.accounts.alt.groupAllowFrom",
      writeTarget: { kind: "account", scope: { channelId: "demo", accountId: "alt" } },
    });
  });

  it("writes an empty named-account override when removing the last inherited entry", async () => {
    const parsedConfig: Record<string, unknown> = {
      channels: { demo: { allowFrom: ["dm-owner"], accounts: { alt: {} } } },
    };

    await edit(parsedConfig, "remove", "dm-owner");

    expect(parsedConfig).toMatchObject({
      channels: { demo: { accounts: { alt: { allowFrom: [] } } } },
    });
  });

  it("keeps an empty channel override after clearing a materialized list", async () => {
    const parsedConfig: Record<string, unknown> = {};
    await edit(parsedConfig, "add", "dm-admin", "default");
    await edit(parsedConfig, "remove", "dm-owner", "default");
    await edit(parsedConfig, "remove", "dm-admin", "default");

    expect(parsedConfig).toMatchObject({
      channels: { demo: { allowFrom: [] } },
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

  it("does not support group scope", () => {
    expect(adapter.supportsScope?.({ scope: "group" })).toBe(false);
  });

  it("reads legacy dm config from the resolved account", () => {
    expect(adapter.readConfig?.({ cfg: {}, accountId: "alt" })).toEqual({
      dmAllowFrom: ["owner"],
      groupPolicy: "allowlist",
      groupOverrides: [{ label: "group-1", entries: ["member-1"] }],
    });
  });

  it("merges legacy entries with undefined and cleans up the old path", () => {
    const alt = {
      allowFrom: undefined,
      dm: { allowFrom: ["Owner", "owner", "", 42, " member "] },
    };
    const parsedConfig = { channels: { demo: { accounts: { alt } } } };
    expect(
      adapter.applyConfigEdit?.({
        cfg: {},
        parsedConfig,
        accountId: "alt",
        scope: "dm",
        action: "add",
        entry: "admin",
      }),
    ).toEqual({
      kind: "ok",
      changed: true,
      pathLabel: "channels.demo.accounts.alt.allowFrom",
      writeTarget: { kind: "account", scope: { channelId: "demo", accountId: "alt" } },
    });
    expect(parsedConfig.channels.demo.accounts.alt).toEqual({
      allowFrom: ["Owner", "owner", "42", "member", "admin"],
      dm: {},
    });
  });
});
