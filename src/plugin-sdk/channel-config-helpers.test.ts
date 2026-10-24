import { describe, expect, it } from "vitest";
import type { ChannelConfigAdapter } from "../channels/plugins/types.adapters.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";
import {
  adaptScopedAccountAccessor,
  authorizeConfigWrite,
  createScopedAccountConfigAccessors,
  createScopedChannelConfigAdapter,
  createScopedChannelConfigBase,
  createHybridChannelConfigAdapter,
  createTopLevelChannelConfigAdapter,
  createTopLevelChannelConfigBase,
  createHybridChannelConfigBase,
  ensureOpenDmPolicyAllowFromWildcard,
  mapAllowFromEntries,
  normalizeChannelDmPolicy,
  resolveChannelDmAccess,
  resolveChannelDmAllowFrom,
  resolveChannelDmPolicy,
  resolveChannelConfigWrites,
  resolveOptionalConfigString,
  setCanonicalDmAllowFrom,
} from "./channel-config-helpers.js";

const resolveDefaultAccountId = () => DEFAULT_ACCOUNT_ID;
const namedAccountBase = {
  sectionKey: "demo",
  listAccountIds: () => ["default", "alt"],
  resolveAccount: (_cfg: unknown, accountId?: string | null) => ({
    accountId: accountId ?? "default",
  }),
  defaultAccountId: resolveDefaultAccountId,
  clearBaseFields: ["token"],
};
const selectors = {
  resolveAllowFrom: (account: { allowFrom: Array<string | number>; defaultTo: string }) =>
    account.allowFrom,
  formatAllowFrom: (entries: Array<string | number>) =>
    entries.map((entry) => String(entry).toUpperCase()),
  resolveDefaultTo: (account: { defaultTo: string }) => account.defaultTo,
};
const enableDefault = { cfg: {}, accountId: "default", enabled: true };
const credentials = { channels: { demo: { token: "secret" } } };
const credentialsAndSettings = {
  channels: { demo: { token: "secret", markdown: { tables: false } } },
};

function createConfigWritesCfg() {
  return {
    channels: {
      telegram: {
        configWrites: true,
        accounts: {
          Work: { configWrites: false },
        },
      },
    },
  };
}

function expectAdapterAllowFromAndDefaultTo(
  channelAdapter: Pick<
    ChannelConfigAdapter<unknown>,
    "resolveAllowFrom" | "resolveDefaultTo" | "setAccountEnabled"
  >,
) {
  expect(channelAdapter.resolveAllowFrom?.({ cfg: {}, accountId: "alt" })).toEqual(["alt"]);
  expect(channelAdapter.resolveDefaultTo?.({ cfg: {}, accountId: "alt" })).toBe("room:123");
  expect(channelAdapter.setAccountEnabled?.(enableDefault)?.channels?.demo).toEqual({
    enabled: true,
  });
}

it("mapAllowFromEntries returns empty list for missing input", () => {
  expect(mapAllowFromEntries(undefined)).toEqual([]);
});

it.each(["   ", undefined])("resolveOptionalConfigString ignores empty or missing %j", (input) => {
  expect(resolveOptionalConfigString(input)).toBeUndefined();
});

describe("channel DM access helpers", () => {
  it("re-exports centralized DM access helpers from the SDK entrypoint", () => {
    const entry = { dm: { policy: "allowlist", allowFrom: ["U1"] } };
    const changes: string[] = [];

    expect(normalizeChannelDmPolicy("allowlist")).toBe("allowlist");
    expect(resolveChannelDmPolicy({ account: entry })).toBe("allowlist");
    expect(resolveChannelDmAllowFrom({ account: entry })).toEqual(["U1"]);

    setCanonicalDmAllowFrom({
      entry,
      mode: "topOnly",
      allowFrom: ["U2"],
      pathPrefix: "channels.demo",
      changes,
      reason: "normalized by SDK helper",
    });

    expect(entry).toEqual({ dm: { policy: "allowlist" }, allowFrom: ["U2"] });
    expect(changes).toEqual([
      "- channels.demo.dm.allowFrom: removed after moving allowlist to channels.demo.allowFrom",
      "- channels.demo.allowFrom: normalized by SDK helper",
    ]);
  });

  it("resolves account legacy allowFrom before inherited root allowFrom", () => {
    expect(
      resolveChannelDmAccess({
        account: { dm: { allowFrom: ["account-legacy"] } },
        parent: { allowFrom: ["root"] },
      }),
    ).toEqual({ allowFrom: ["account-legacy"], dmPolicy: undefined });
  });

  it("keeps nested-only channels on dm.allowFrom", () => {
    const entry = { dmPolicy: "open", allowFrom: ["matrix:@owner"] };
    const changes: string[] = [];

    ensureOpenDmPolicyAllowFromWildcard({
      entry,
      mode: "nestedOnly",
      pathPrefix: "channels.matrix",
      changes,
    });

    expect(entry).toEqual({ dm: { policy: "open", allowFrom: ["matrix:@owner", "*"] } });
    expect(changes).toEqual([
      '- channels.matrix.dm.policy: set to "open" (migrated from channels.matrix.dmPolicy)',
      "- channels.matrix.allowFrom: removed after moving allowlist to channels.matrix.dm.allowFrom",
      '- channels.matrix.dm.allowFrom: added "*" (required by dmPolicy="open")',
    ]);
  });
});

describe("config write helpers", () => {
  it("matches account ids case-insensitively", () => {
    expect(
      resolveChannelConfigWrites({
        cfg: createConfigWritesCfg(),
        channelId: "telegram",
        accountId: "work",
      }),
    ).toBe(false);
  });

  it("blocks account-scoped writes when the configured account key differs only by case", () => {
    expect(
      authorizeConfigWrite({
        cfg: createConfigWritesCfg(),
        target: {
          kind: "account",
          scope: { channelId: "telegram", accountId: "work" },
        },
      }),
    ).toEqual({
      allowed: false,
      reason: "target-disabled",
      blockedScope: {
        kind: "target",
        scope: { channelId: "telegram", accountId: "work" },
      },
    });
  });
});

it("adaptScopedAccountAccessor binds positional callback args into the shared account context", () => {
  const accessor = adaptScopedAccountAccessor(({ cfg, accountId }) => ({
    channel: cfg.channels?.demo,
    accountId: accountId ?? "default",
  }));

  expect(accessor({ channels: { demo: { enabled: true } } }, "alt")).toEqual({
    channel: { enabled: true },
    accountId: "alt",
  });
});

describe("createScopedAccountConfigAccessors", () => {
  it("maps allowFrom and defaultTo from the resolved account", () => {
    const accessors = createScopedAccountConfigAccessors({
      resolveAccount: ({ accountId }) => ({
        allowFrom: accountId ? [accountId, 42] : ["fallback"],
        defaultTo: " room:123 ",
      }),
      ...selectors,
    });

    expect(accessors.resolveAllowFrom?.({ cfg: {}, accountId: "owner" })).toEqual(["owner", "42"]);
    expect(accessors.formatAllowFrom?.({ cfg: {}, allowFrom: ["owner"] })).toEqual(["OWNER"]);
    expect(accessors.resolveDefaultTo?.({ cfg: {}, accountId: "owner" })).toBe("room:123");
  });

  it("omits resolveDefaultTo when no selector is provided", () => {
    const accessors = createScopedAccountConfigAccessors({
      resolveAccount: () => ({ allowFrom: ["owner"] }),
      resolveAllowFrom: (account) => account.allowFrom,
      formatAllowFrom: (allowFrom) => allowFrom.map((entry) => String(entry)),
    });

    expect(accessors.resolveDefaultTo).toBeUndefined();
  });
});

it("createScopedChannelConfigBase wires shared account config CRUD through the section helper", () => {
  const base = createScopedChannelConfigBase(namedAccountBase);

  expect(base.listAccountIds({})).toEqual(["default", "alt"]);
  expect(base.resolveAccount({}, "alt")).toEqual({ accountId: "alt" });
  expect(base.defaultAccountId!({})).toBe("default");
  expect(base.setAccountEnabled!(enableDefault).channels?.demo).toEqual({ enabled: true });
  expect(base.deleteAccount!({ cfg: credentials, accountId: "default" }).channels).toBeUndefined();
});

describe("createScopedChannelConfigAdapter", () => {
  it("combines scoped CRUD and allowFrom accessors", () => {
    const adapter = createScopedChannelConfigAdapter({
      ...namedAccountBase,
      resolveAccount: (_cfg, accountId) => ({
        accountId: accountId ?? "default",
        allowFrom: accountId ? [accountId] : ["fallback"],
        defaultTo: " room:123 ",
      }),
      ...selectors,
    });

    expect(adapter.listAccountIds({})).toEqual(["default", "alt"]);
    expect(adapter.resolveAccount({}, "alt")).toEqual({
      accountId: "alt",
      allowFrom: ["alt"],
      defaultTo: " room:123 ",
    });
    expectAdapterAllowFromAndDefaultTo(adapter);
  });

  it("keeps read-only accessors on the accessor resolver", () => {
    const adapter = createScopedChannelConfigAdapter<
      { accountId: string; token: string },
      { allowFrom: string[]; defaultTo: string }
    >({
      ...namedAccountBase,
      listAccountIds: () => ["default"],
      resolveAccount: () => {
        throw new Error("runtime account resolver should not run for read-only accessors");
      },
      resolveAccessorAccount: ({ accountId }) => ({
        allowFrom: [accountId ?? "default"],
        defaultTo: " room:123 ",
      }),
      resolveAllowFrom: (account) => account.allowFrom,
      formatAllowFrom: (allowFrom) => allowFrom.map((entry) => String(entry)),
      resolveDefaultTo: (account) => account.defaultTo,
    });

    expect(adapter.resolveAllowFrom?.({ cfg: {}, accountId: "default" })).toEqual(["default"]);
    expect(adapter.resolveDefaultTo?.({ cfg: {}, accountId: "default" })).toBe("room:123");
  });
});

it("createTopLevelChannelConfigBase wires top-level enable/delete semantics", () => {
  const base = createTopLevelChannelConfigBase({
    sectionKey: "demo",
    resolveAccount: () => ({ accountId: "default" }),
  });

  expect(base.listAccountIds({})).toEqual(["default"]);
  expect(base.defaultAccountId!({})).toBe("default");
  expect(base.setAccountEnabled!(enableDefault).channels?.demo).toEqual({ enabled: true });
  expect(
    base.deleteAccount!({
      cfg: { channels: { demo: { enabled: true } } },
      accountId: "default",
    }).channels,
  ).toBeUndefined();
});

it("createTopLevelChannelConfigAdapter combines CRUD with separate accessor account resolution", () => {
  const adapter = createTopLevelChannelConfigAdapter<
    { accountId: string; enabled: boolean },
    { allowFrom: string[]; defaultTo: string }
  >({
    sectionKey: "demo",
    resolveAccount: () => ({ accountId: "default", enabled: true }),
    resolveAccessorAccount: () => ({ allowFrom: ["owner"], defaultTo: " chat:123 " }),
    deleteMode: "clear-fields",
    clearBaseFields: ["token"],
    resolveAllowFrom: (account) => account.allowFrom,
    formatAllowFrom: (allowFrom) => allowFrom.map((entry) => String(entry)),
    resolveDefaultTo: (account) => account.defaultTo,
  });

  expect(adapter.resolveAccount({})).toEqual({ accountId: "default", enabled: true });
  expect(adapter.resolveAllowFrom?.({ cfg: {} })).toEqual(["owner"]);
  expect(adapter.resolveDefaultTo?.({ cfg: {} })).toBe("chat:123");
  expect(
    adapter.deleteAccount!({
      cfg: credentialsAndSettings,
      accountId: "default",
    }).channels?.demo,
  ).toEqual({
    markdown: { tables: false },
  });
});

it("createHybridChannelConfigBase enables default at root and named accounts under accounts", () => {
  const base = createHybridChannelConfigBase(namedAccountBase);

  expect(
    base.setAccountEnabled!({
      cfg: { channels: { demo: { accounts: { alt: { enabled: false } } } } },
      accountId: "default",
      enabled: true,
    }).channels?.demo,
  ).toEqual({
    accounts: { alt: { enabled: false } },
    enabled: true,
  });
  expect(
    base.setAccountEnabled!({
      cfg: {},
      accountId: "alt",
      enabled: true,
    }).channels?.demo,
  ).toEqual({
    accounts: { alt: { enabled: true } },
  });
});

it("createHybridChannelConfigAdapter combines hybrid CRUD with allowFrom/defaultTo accessors", () => {
  const adapter = createHybridChannelConfigAdapter<
    { accountId: string; enabled: boolean },
    { allowFrom: string[]; defaultTo: string }
  >({
    ...namedAccountBase,
    resolveAccount: (_cfg, accountId) => ({
      accountId: accountId ?? "default",
      enabled: true,
    }),
    resolveAccessorAccount: ({ accountId }) => ({
      allowFrom: [accountId ?? "default"],
      defaultTo: " room:123 ",
    }),
    preserveSectionOnDefaultDelete: true,
    ...selectors,
  });

  expectAdapterAllowFromAndDefaultTo(adapter);
  expect(
    adapter.deleteAccount!({
      cfg: credentialsAndSettings,
      accountId: "default",
    }).channels?.demo,
  ).toEqual({
    markdown: { tables: false },
  });
});
