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
    ["authoritative unlisted default", "unlisted", undefined, ["first"], "unlisted", 0],
    ["authoritative empty default", "", undefined, ["first"], "", 0],
    ["default before supplied accounts", "chosen", ["supplied"], ["first"], "chosen", 0],
    ["default before supplied empty list", "chosen", [], ["first"], "chosen", 0],
    ["supplied first account", undefined, ["supplied", "second"], ["first"], "supplied", 0],
    ["supplied empty list", undefined, [], ["first"], "default", 0],
    ["enumerated first account", undefined, undefined, ["first", "second"], "first", 1],
    ["empty enumeration fallback", undefined, undefined, [], "default", 1],
    ["empty first account is preserved", undefined, undefined, ["", "second"], "", 1],
  ] satisfies [string, string | undefined, string[] | undefined, string[], string, number][])(
    "preserves %s",
    (_name, defaultId, supplied, listed, expected, enumerations) => {
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
    },
  );
});

function cfgWithChannel(channelKey: string, accounts?: Record<string, unknown>): OpenClawConfig {
  return {
    channels: {
      [channelKey]: accounts ? { accounts } : {},
    },
  } as unknown as OpenClawConfig;
}

function expectedPolicy(policy: string, allowFrom: string[], base: string, channel: string) {
  return {
    policy,
    allowFrom,
    policyPath: `${base}dmPolicy`,
    allowFromPath: base,
    approveHint: formatPairingApproveHint(channel),
    normalizeEntry: undefined,
  };
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
      expected: expectedPolicy("pairing", ["123"], "channels.demo-root.", "demo-root"),
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
      expected: expectedPolicy(
        "allowlist",
        ["+12125551212"],
        "channels.demo-account.accounts.work.",
        "demo-account",
      ),
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
        ...expectedPolicy("pairing", [], "channels.demo-nested.accounts.work.", "demo-nested"),
        policyPath: undefined,
        allowFromPath: "channels.demo-nested.accounts.work.dm.",
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
      expected: expectedPolicy(
        "allowlist",
        ["+15550001111"],
        "channels.demo-default-account.accounts.default.",
        "demo-default-account",
      ),
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
      expected: expectedPolicy("pairing", ["*"], "channels.demo-root.", "demo-root"),
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
        ...expectedPolicy("allowlist", ["user-1"], "channels.demo-default.", "demo-default"),
        approveHint: "openclaw pairing approve demo-default <code>",
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
