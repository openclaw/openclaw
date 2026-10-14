// Channel plugin helper tests cover shared plugin helper behavior and edge cases.
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { createChannelTestPluginBase } from "../../test-utils/channel-plugins.js";
import {
  buildAccountScopedDmSecurityPolicy,
  formatPairingApproveHint,
  parseOptionalDelimitedEntries,
  resolveChannelDefaultAccountId,
} from "./helpers.js";

describe("resolveChannelDefaultAccountId", () => {
  it.each([
    {
      name: "authoritative unlisted default",
      defaultId: "unlisted",
      supplied: undefined,
      listed: ["first"],
      expected: "unlisted",
      enumerations: 0,
    },
    {
      name: "authoritative empty default",
      defaultId: "",
      supplied: undefined,
      listed: ["first"],
      expected: "",
      enumerations: 0,
    },
    {
      name: "default before supplied accounts",
      defaultId: "chosen",
      supplied: ["supplied"],
      listed: ["first"],
      expected: "chosen",
      enumerations: 0,
    },
    {
      name: "default before supplied empty list",
      defaultId: "chosen",
      supplied: [],
      listed: ["first"],
      expected: "chosen",
      enumerations: 0,
    },
    {
      name: "supplied first account",
      defaultId: undefined,
      supplied: ["supplied", "second"],
      listed: ["first"],
      expected: "supplied",
      enumerations: 0,
    },
    {
      name: "supplied empty list",
      defaultId: undefined,
      supplied: [],
      listed: ["first"],
      expected: "default",
      enumerations: 0,
    },
    {
      name: "enumerated first account",
      defaultId: undefined,
      supplied: undefined,
      listed: ["first", "second"],
      expected: "first",
      enumerations: 1,
    },
    {
      name: "empty enumeration fallback",
      defaultId: undefined,
      supplied: undefined,
      listed: [],
      expected: "default",
      enumerations: 1,
    },
    {
      name: "empty first account is preserved",
      defaultId: undefined,
      supplied: undefined,
      listed: ["", "second"],
      expected: "",
      enumerations: 1,
    },
  ])("preserves $name", ({ defaultId, supplied, listed, expected, enumerations }) => {
    const cfg: OpenClawConfig = {};
    const before = structuredClone({ cfg, supplied, listed });
    const plugin = createChannelTestPluginBase({ id: "accountchat" });
    const listAccountIds = vi.fn(function (this: typeof plugin.config, received: OpenClawConfig) {
      expect(this).toBe(plugin.config);
      expect(received).toBe(cfg);
      return listed;
    });
    plugin.config.listAccountIds = listAccountIds;
    const defaultAccountId =
      defaultId === undefined
        ? undefined
        : vi.fn(function (this: typeof plugin.config, received: OpenClawConfig) {
            expect(this).toBe(plugin.config);
            expect(received).toBe(cfg);
            return defaultId;
          });
    plugin.config.defaultAccountId = defaultAccountId;

    expect(resolveChannelDefaultAccountId({ plugin, cfg, accountIds: supplied })).toBe(expected);
    expect({ cfg, supplied, listed }).toEqual(before);
    if (defaultAccountId) {
      expect(defaultAccountId).toHaveBeenCalledOnce();
    }
    expect(listAccountIds).toHaveBeenCalledTimes(enumerations);
  });
});

function cfgWithChannel(channelKey: string, accounts?: Record<string, unknown>): OpenClawConfig {
  return {
    channels: {
      [channelKey]: accounts ? { accounts } : {},
    },
  } as unknown as OpenClawConfig;
}

describe("buildAccountScopedDmSecurityPolicy", () => {
  it.each([
    {
      name: "builds top-level dm policy paths when no account config exists",
      input: {
        cfg: cfgWithChannel("demo-root"),
        channelKey: "demo-root",
        fallbackAccountId: "default",
        policy: "pairing",
        allowFrom: ["123"],
        policyPathSuffix: "dmPolicy",
      },
      expected: {
        policy: "pairing",
        allowFrom: ["123"],
        policyPath: "channels.demo-root.dmPolicy",
        allowFromPath: "channels.demo-root.",
        approveHint: formatPairingApproveHint("demo-root"),
        normalizeEntry: undefined,
      },
    },
    {
      name: "uses account-scoped paths when account config exists",
      input: {
        cfg: cfgWithChannel("demo-account", { work: {} }),
        channelKey: "demo-account",
        accountId: "work",
        fallbackAccountId: "default",
        policy: "allowlist",
        allowFrom: ["+12125551212"],
        policyPathSuffix: "dmPolicy",
      },
      expected: {
        policy: "allowlist",
        allowFrom: ["+12125551212"],
        policyPath: "channels.demo-account.accounts.work.dmPolicy",
        allowFromPath: "channels.demo-account.accounts.work.",
        approveHint: formatPairingApproveHint("demo-account"),
        normalizeEntry: undefined,
      },
    },
    {
      name: "supports nested dm paths without explicit policyPath",
      input: {
        cfg: cfgWithChannel("demo-nested", { work: {} }),
        channelKey: "demo-nested",
        accountId: "work",
        policy: "pairing",
        allowFrom: [],
        allowFromPathSuffix: "dm.",
      },
      expected: {
        policy: "pairing",
        allowFrom: [],
        policyPath: undefined,
        allowFromPath: "channels.demo-nested.accounts.work.dm.",
        approveHint: formatPairingApproveHint("demo-nested"),
        normalizeEntry: undefined,
      },
    },
    {
      name: "uses accounts.default paths when shared defaults are inherited",
      input: {
        cfg: cfgWithChannel("demo-default-account", {
          default: {
            dmPolicy: "allowlist",
            allowFrom: ["+15550001111"],
          },
          work: {},
        }),
        channelKey: "demo-default-account",
        accountId: "work",
        fallbackAccountId: "default",
        policy: "allowlist",
        allowFrom: ["+15550001111"],
        policyPathSuffix: "dmPolicy",
        inheritSharedDefaultsFromDefaultAccount: true,
      },
      expected: {
        policy: "allowlist",
        allowFrom: ["+15550001111"],
        policyPath: "channels.demo-default-account.accounts.default.dmPolicy",
        allowFromPath: "channels.demo-default-account.accounts.default.",
        approveHint: formatPairingApproveHint("demo-default-account"),
        normalizeEntry: undefined,
      },
    },
    {
      name: "ignores accounts.default paths unless the channel opts into shared default-account inheritance",
      input: {
        cfg: {
          channels: {
            "demo-root": {
              dmPolicy: "pairing",
              allowFrom: ["*"],
              accounts: {
                default: {
                  dmPolicy: "allowlist",
                  allowFrom: ["+15550001111"],
                },
                work: {},
              },
            },
          },
        } as unknown as OpenClawConfig,
        channelKey: "demo-root",
        accountId: "work",
        fallbackAccountId: "default",
        policy: "pairing",
        allowFrom: ["*"],
        policyPathSuffix: "dmPolicy",
      },
      expected: {
        policy: "pairing",
        allowFrom: ["*"],
        policyPath: "channels.demo-root.dmPolicy",
        allowFromPath: "channels.demo-root.",
        approveHint: formatPairingApproveHint("demo-root"),
        normalizeEntry: undefined,
      },
    },
    {
      name: "supports custom defaults and approve hints",
      input: {
        cfg: cfgWithChannel("demo-default"),
        channelKey: "demo-default",
        fallbackAccountId: "default",
        allowFrom: ["user-1"],
        defaultPolicy: "allowlist",
        policyPathSuffix: "dmPolicy",
        approveHint: "openclaw pairing approve demo-default <code>",
      },
      expected: {
        policy: "allowlist",
        allowFrom: ["user-1"],
        policyPath: "channels.demo-default.dmPolicy",
        allowFromPath: "channels.demo-default.",
        approveHint: "openclaw pairing approve demo-default <code>",
        normalizeEntry: undefined,
      },
    },
  ])("$name", ({ input, expected }) => {
    expect(buildAccountScopedDmSecurityPolicy(input)).toEqual(expected);
  });
});

describe("parseOptionalDelimitedEntries", () => {
  it("returns undefined for empty input", () => {
    expect(parseOptionalDelimitedEntries("  ")).toBeUndefined();
  });

  it("splits comma, newline, and semicolon separated entries", () => {
    expect(parseOptionalDelimitedEntries("alpha, beta\ngamma; delta")).toEqual([
      "alpha",
      "beta",
      "gamma",
      "delta",
    ]);
  });
});
