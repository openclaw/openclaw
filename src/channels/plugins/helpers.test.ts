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
      const checkedReader = <T>(value: T) =>
        vi.fn(function (this: typeof plugin.config, received: OpenClawConfig) {
          expect(this).toBe(plugin.config);
          expect(received).toBe(cfg);
          return value;
        });
      const listAccountIds = checkedReader(listed);
      plugin.config.listAccountIds = listAccountIds;
      const defaultAccountId = defaultId === undefined ? undefined : checkedReader(defaultId);
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

type PolicyInput = Parameters<typeof buildAccountScopedDmSecurityPolicy>[0];

function expectedPolicy(policy: string, allowFrom: string[], scope = "", suffix = "") {
  const base = `channels.demo.${scope}`;
  return {
    policy,
    allowFrom,
    policyPath: suffix ? undefined : `${base}dmPolicy`,
    allowFromPath: `${base}${suffix}`,
    approveHint: formatPairingApproveHint("demo"),
    normalizeEntry: undefined,
  };
}

describe("buildAccountScopedDmSecurityPolicy", () => {
  it.each([
    [
      "top-level paths",
      { policy: "pairing", allowFrom: ["123"] },
      {},
      expectedPolicy("pairing", ["123"]),
    ],
    [
      "account paths",
      { accountId: "work", policy: "allowlist", allowFrom: ["+12125551212"] },
      { accounts: { work: {} } },
      expectedPolicy("allowlist", ["+12125551212"], "accounts.work."),
    ],
    [
      "nested paths without a policy path",
      {
        accountId: "work",
        policy: "pairing",
        allowFrom: [],
        allowFromPathSuffix: "dm.",
        policyPathSuffix: undefined,
      },
      { accounts: { work: {} } },
      expectedPolicy("pairing", [], "accounts.work.", "dm."),
    ],
    [
      "inherited default-account paths",
      {
        accountId: "work",
        policy: "allowlist",
        allowFrom: ["+15550001111"],
        inheritSharedDefaultsFromDefaultAccount: true,
      },
      { accounts: { default: { dmPolicy: "allowlist", allowFrom: ["+15550001111"] }, work: {} } },
      expectedPolicy("allowlist", ["+15550001111"], "accounts.default."),
    ],
    [
      "root paths without inheritance opt-in",
      { accountId: "work", policy: "pairing", allowFrom: ["*"] },
      {
        dmPolicy: "pairing",
        allowFrom: ["*"],
        accounts: { default: { dmPolicy: "allowlist", allowFrom: ["+15550001111"] }, work: {} },
      },
      expectedPolicy("pairing", ["*"]),
    ],
    [
      "custom defaults and approve hints",
      { allowFrom: ["user-1"], defaultPolicy: "allowlist", approveHint: "custom approval" },
      {},
      { ...expectedPolicy("allowlist", ["user-1"]), approveHint: "custom approval" },
    ],
  ] satisfies [
    string,
    Omit<PolicyInput, "cfg" | "channelKey">,
    Record<string, unknown>,
    ReturnType<typeof expectedPolicy>,
  ][])("supports %s", (_name, overrides, section, expected) => {
    expect(
      buildAccountScopedDmSecurityPolicy({
        channelKey: "demo",
        cfg: { channels: { demo: section } },
        fallbackAccountId: "default",
        policyPathSuffix: "dmPolicy",
        ...overrides,
      }),
    ).toEqual(expected);
  });
});

describe("parseOptionalDelimitedEntries", () => {
  it.each([
    { input: "  ", expected: undefined },
    { input: "alpha, beta\ngamma; delta", expected: ["alpha", "beta", "gamma", "delta"] },
  ])("parses $input", ({ input, expected }) => {
    expect(parseOptionalDelimitedEntries(input)).toEqual(expected);
  });
});
