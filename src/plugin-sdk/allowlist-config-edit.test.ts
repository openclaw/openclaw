import { expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as sdk from "./allowlist-config-edit.js";

const options = {
  channelId: "demo",
  resolveAccount: () => ({
    dmAllowFrom: ["owner"],
    groupAllowFrom: ["group-owner"],
    dmPolicy: "allowlist",
    groupPolicy: "allowlist",
    groupOverrides: [{ label: "room", entries: ["member-1"] }],
  }),
  normalize: ({ values }: { values: Array<string | number> }) =>
    values.map((entry) => String(entry).trim().toLowerCase()),
  resolveDmAllowFrom: (account: { dmAllowFrom: string[] }) => account.dmAllowFrom,
  resolveGroupPolicy: (account: { groupPolicy: string }) => account.groupPolicy,
  resolveGroupOverrides: (account: {
    groupOverrides: Array<{ label: string; entries: string[] }>;
  }) => account.groupOverrides,
};
const modern = sdk.buildDmGroupAccountAllowlistAdapter({
  ...options,
  resolveGroupAllowFrom: (account) => account.groupAllowFrom,
  resolveDmPolicy: (account) => account.dmPolicy,
});
const legacy = sdk.buildLegacyDmAccountAllowlistAdapter(options);
const readConfig = {
  dmAllowFrom: ["owner"],
  groupPolicy: "allowlist",
  groupOverrides: [{ label: "room", entries: ["member-1"] }],
};
function edit(
  adapter: typeof modern,
  parsedConfig: Record<string, unknown>,
  action: "add" | "remove",
  entry: string,
  accountId = "alt",
  scope: "dm" | "group" = "dm",
) {
  return adapter.applyConfigEdit?.({
    cfg: parsedConfig as OpenClawConfig,
    parsedConfig,
    accountId,
    scope,
    action,
    entry,
  });
}

it("builds flat overrides with nonempty, string-coerced entries", () => {
  const account = { channels: { room1: { users: ["a", 42, ""] }, room2: { users: [] } } };
  const resolve = sdk.createFlatAllowlistOverrideResolver({
    resolveRecord: (value: typeof account) => value.channels,
    label: (key) => key,
    resolveEntries: (value) => value.users,
  });
  expect(resolve(account)).toEqual([{ label: "room1", entries: ["a", "42"] }]);
});
it("builds nested overrides with outer and inner labels", () => {
  const account = {
    groups: { g1: { allowFrom: ["owner"], topics: { t1: { allowFrom: ["member"] } } } },
  };
  const resolve = sdk.createNestedAllowlistOverrideResolver({
    resolveRecord: (value: typeof account) => value.groups,
    outerLabel: (id) => id,
    resolveOuterEntries: (group) => group.allowFrom,
    resolveChildren: (group) => group.topics,
    innerLabel: (group, topic) => `${group} topic ${topic}`,
    resolveInnerEntries: (topic) => topic.allowFrom,
  });
  expect(resolve(account)).toEqual([
    { label: "g1", entries: ["owner"] },
    { label: "g1 topic t1", entries: ["member"] },
  ]);
});
it.each([
  { token: "", expected: [] },
  { token: " secret ", expected: [{ input: "a", resolved: true, name: "secret:a" }] },
])("requires a nonempty trimmed token: '$token'", async ({ token, expected }) => {
  const resolve = sdk.createAccountScopedAllowlistNameResolver({
    resolveAccount: () => ({ token }),
    resolveToken: (account) => account.token,
    resolveNames: async ({ token: auth, entries }) =>
      entries.map((input) => ({ input, resolved: true, name: `${auth}:${input}` })),
  });
  expect(await resolve({ cfg: {}, accountId: "alt", scope: "dm", entries: ["a"] })).toEqual(
    expected,
  );
});
it.each([
  [modern, "all", true, { ...readConfig, dmPolicy: "allowlist", groupAllowFrom: ["group-owner"] }],
  [legacy, "group", false, readConfig],
] as const)(
  "reads account config and declares scope support: %j",
  (adapter, scope, supported, expected) => {
    expect(adapter.supportsScope?.({ scope })).toBe(supported);
    expect(adapter.readConfig?.({ cfg: {}, accountId: "alt" })).toEqual(expected);
  },
);
it("targets groupAllowFrom on the named account", () =>
  expect(edit(modern, {}, "add", " Member-2 ", "alt", "group")).toEqual({
    kind: "ok",
    changed: true,
    pathLabel: "channels.demo.accounts.alt.groupAllowFrom",
    writeTarget: { kind: "account", scope: { channelId: "demo", accountId: "alt" } },
  }));
it("keeps an empty named override after removing the last inherited entry", async () => {
  const config = { channels: { demo: { allowFrom: ["owner"], accounts: { alt: {} } } } };
  await edit(modern, config, "remove", "owner");
  expect(config).toMatchObject({ channels: { demo: { accounts: { alt: { allowFrom: [] } } } } });
});
it("keeps an empty channel override after clearing a materialized list", async () => {
  const config = {};
  await edit(modern, config, "add", "admin", "default");
  await edit(modern, config, "remove", "owner", "default");
  await edit(modern, config, "remove", "admin", "default");
  expect(config).toMatchObject({ channels: { demo: { allowFrom: [] } } });
});
it("merges legacy entries and removes the old path", () => {
  const alt = { allowFrom: undefined, dm: { allowFrom: ["Owner", "owner", "", 42, " member "] } };
  const config = { channels: { demo: { accounts: { alt } } } };
  expect(edit(legacy, config, "add", "admin")).toEqual({
    kind: "ok",
    changed: true,
    pathLabel: "channels.demo.accounts.alt.allowFrom",
    writeTarget: { kind: "account", scope: { channelId: "demo", accountId: "alt" } },
  });
  expect(config.channels.demo.accounts.alt).toEqual({
    allowFrom: ["Owner", "owner", "42", "member", "admin"],
    dm: {},
  });
});
