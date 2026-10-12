/**
 * Tests channel config helper authorization and write-scope behavior.
 */
import { describe, expect, it } from "vitest";
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

function expectAdapterAllowFromAndDefaultTo(adapter: unknown) {
  const channelAdapter = adapter as {
    resolveAllowFrom?: (params: { cfg: object; accountId: string }) => unknown;
    resolveDefaultTo?: (params: { cfg: object; accountId: string }) => unknown;
    setAccountEnabled?: (params: { cfg: object; accountId: string; enabled: boolean }) => {
      channels?: {
        demo?: unknown;
      };
    };
  };

  expect(channelAdapter.resolveAllowFrom?.({ cfg: {}, accountId: "alt" })).toEqual(["alt"]);
  expect(channelAdapter.resolveDefaultTo?.({ cfg: {}, accountId: "alt" })).toBe("room:123");
  expect(
    channelAdapter.setAccountEnabled?.({
      cfg: {},
      accountId: "default",
      enabled: true,
    })?.channels?.demo,
  ).toEqual({ enabled: true });
}

describe("mapAllowFromEntries", () => {
  it("returns empty list for missing input", () => {
    expect(mapAllowFromEntries(undefined)).toEqual([]);
  });
});

describe("resolveOptionalConfigString", () => {
  it.each([
    {
      name: "returns undefined for empty string values",
      input: "   ",
      expected: undefined,
    },
    {
      name: "returns undefined for missing values",
      input: undefined,
      expected: undefined,
    },
  ])("$name", ({ input, expected }) => {
    expect(resolveOptionalConfigString(input)).toBe(expected);
  });
});

describe("channel DM access helpers", () => {
  it("re-exports centralized DM access helpers from the SDK entrypoint", () => {
    const entry = { dm: { policy: "allowlist", allowFrom: ["U1"] } };
    const changes: string[] = [];

    expect(normalizeChannelDmPolicy("allowlist")).toBe("allowlist");
    expect(
      resolveChannelDmPolicy({
        account: entry,
      }),
    ).toBe("allowlist");
    expect(
      resolveChannelDmAllowFrom({
        account: entry,
      }),
    ).toEqual(["U1"]);

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

describe("adaptScopedAccountAccessor", () => {
  it("binds positional callback args into the shared account context object", () => {
    const accessor = adaptScopedAccountAccessor(({ cfg, accountId }) => ({
      channel: cfg.channels?.demo,
      accountId: accountId ?? "default",
    }));

    expect(
      accessor(
        {
          channels: {
            demo: {
              enabled: true,
            },
          },
        },
        "alt",
      ),
    ).toEqual({
      channel: {
        enabled: true,
      },
      accountId: "alt",
    });
  });
});

describe("createScopedAccountConfigAccessors", () => {
  it("maps allowFrom and defaultTo from the resolved account", () => {
    const accessors = createScopedAccountConfigAccessors({
      resolveAccount: ({ accountId }) => ({
        allowFrom: accountId ? [accountId, 42] : ["fallback"],
        defaultTo: " room:123 ",
      }),
      resolveAllowFrom: (account) => account.allowFrom,
      formatAllowFrom: (allowFrom) => allowFrom.map((entry) => String(entry).toUpperCase()),
      resolveDefaultTo: (account) => account.defaultTo,
    });

    expect(
      accessors.resolveAllowFrom?.({
        cfg: {},
        accountId: "owner",
      }),
    ).toEqual(["owner", "42"]);
    expect(
      accessors.formatAllowFrom?.({
        cfg: {},
        allowFrom: ["owner"],
      }),
    ).toEqual(["OWNER"]);
    expect(
      accessors.resolveDefaultTo?.({
        cfg: {},
        accountId: "owner",
      }),
    ).toBe("room:123");
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

describe("createScopedChannelConfigBase", () => {
  it("wires shared account config CRUD through the section helper", () => {
    const base = createScopedChannelConfigBase({
      sectionKey: "demo",
      listAccountIds: () => ["default", "alt"],
      resolveAccount: (_cfg, accountId) => ({ accountId: accountId ?? "default" }),
      defaultAccountId: resolveDefaultAccountId,
      clearBaseFields: ["token"],
    });

    expect(base.listAccountIds({})).toEqual(["default", "alt"]);
    expect(base.resolveAccount({}, "alt")).toEqual({ accountId: "alt" });
    expect(base.defaultAccountId!({})).toBe("default");
    expect(
      base.setAccountEnabled!({
        cfg: {},
        accountId: "default",
        enabled: true,
      }).channels?.demo,
    ).toEqual({ enabled: true });
    expect(
      base.deleteAccount!({
        cfg: {
          channels: {
            demo: {
              token: "secret",
            },
          },
        },
        accountId: "default",
      }).channels,
    ).toBeUndefined();
  });
});

describe("createScopedChannelConfigAdapter", () => {
  it("combines scoped CRUD and allowFrom accessors", () => {
    const adapter = createScopedChannelConfigAdapter({
      sectionKey: "demo",
      listAccountIds: () => ["default", "alt"],
      resolveAccount: (_cfg, accountId) => ({
        accountId: accountId ?? "default",
        allowFrom: accountId ? [accountId] : ["fallback"],
        defaultTo: " room:123 ",
      }),
      defaultAccountId: resolveDefaultAccountId,
      clearBaseFields: ["token"],
      resolveAllowFrom: (account) => account.allowFrom,
      formatAllowFrom: (allowFrom) => allowFrom.map((entry) => String(entry).toUpperCase()),
      resolveDefaultTo: (account) => account.defaultTo,
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
      sectionKey: "demo",
      listAccountIds: () => ["default"],
      resolveAccount: () => {
        throw new Error("runtime account resolver should not run for read-only accessors");
      },
      resolveAccessorAccount: ({ accountId }) => ({
        allowFrom: [accountId ?? "default"],
        defaultTo: " room:123 ",
      }),
      defaultAccountId: resolveDefaultAccountId,
      clearBaseFields: ["token"],
      resolveAllowFrom: (account) => account.allowFrom,
      formatAllowFrom: (allowFrom) => allowFrom.map((entry) => String(entry)),
      resolveDefaultTo: (account) => account.defaultTo,
    });

    expect(adapter.resolveAllowFrom?.({ cfg: {}, accountId: "default" })).toEqual(["default"]);
    expect(adapter.resolveDefaultTo?.({ cfg: {}, accountId: "default" })).toBe("room:123");
  });
});

describe("createTopLevelChannelConfigBase", () => {
  it("wires top-level enable/delete semantics", () => {
    const base = createTopLevelChannelConfigBase({
      sectionKey: "demo",
      resolveAccount: () => ({ accountId: "default" }),
    });

    expect(base.listAccountIds({})).toEqual(["default"]);
    expect(base.defaultAccountId!({})).toBe("default");
    expect(
      base.setAccountEnabled!({
        cfg: {},
        accountId: "default",
        enabled: true,
      }).channels?.demo,
    ).toEqual({ enabled: true });
    expect(
      base.deleteAccount!({
        cfg: {
          channels: {
            demo: {
              enabled: true,
            },
          },
        },
        accountId: "default",
      }).channels,
    ).toBeUndefined();
  });
});

describe("createTopLevelChannelConfigAdapter", () => {
  it("combines top-level CRUD with separate accessor account resolution", () => {
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
        cfg: {
          channels: {
            demo: {
              token: "secret",
              markdown: { tables: false },
            },
          },
        },
        accountId: "default",
      }).channels?.demo,
    ).toEqual({
      markdown: { tables: false },
    });
  });
});

describe("createHybridChannelConfigBase", () => {
  it("writes default account enable at the channel root and named accounts under accounts", () => {
    const base = createHybridChannelConfigBase({
      sectionKey: "demo",
      listAccountIds: () => ["default", "alt"],
      resolveAccount: (_cfg, accountId) => ({ accountId: accountId ?? "default" }),
      defaultAccountId: resolveDefaultAccountId,
      clearBaseFields: ["token"],
    });

    expect(
      base.setAccountEnabled!({
        cfg: {
          channels: {
            demo: {
              accounts: {
                alt: { enabled: false },
              },
            },
          },
        },
        accountId: "default",
        enabled: true,
      }).channels?.demo,
    ).toEqual({
      accounts: {
        alt: { enabled: false },
      },
      enabled: true,
    });
    expect(
      base.setAccountEnabled!({
        cfg: {},
        accountId: "alt",
        enabled: true,
      }).channels?.demo,
    ).toEqual({
      accounts: {
        alt: { enabled: true },
      },
    });
  });
});

describe("createHybridChannelConfigAdapter", () => {
  it("combines hybrid CRUD with allowFrom/defaultTo accessors", () => {
    const adapter = createHybridChannelConfigAdapter<
      { accountId: string; enabled: boolean },
      { allowFrom: string[]; defaultTo: string }
    >({
      sectionKey: "demo",
      listAccountIds: () => ["default", "alt"],
      resolveAccount: (_cfg, accountId) => ({
        accountId: accountId ?? "default",
        enabled: true,
      }),
      resolveAccessorAccount: ({ accountId }) => ({
        allowFrom: [accountId ?? "default"],
        defaultTo: " room:123 ",
      }),
      defaultAccountId: resolveDefaultAccountId,
      clearBaseFields: ["token"],
      preserveSectionOnDefaultDelete: true,
      resolveAllowFrom: (account) => account.allowFrom,
      formatAllowFrom: (allowFrom) => allowFrom.map((entry) => String(entry).toUpperCase()),
      resolveDefaultTo: (account) => account.defaultTo,
    });

    expectAdapterAllowFromAndDefaultTo(adapter);
    expect(
      adapter.deleteAccount!({
        cfg: {
          channels: {
            demo: {
              token: "secret",
              markdown: { tables: false },
            },
          },
        },
        accountId: "default",
      }).channels?.demo,
    ).toEqual({
      markdown: { tables: false },
    });
  });
});
