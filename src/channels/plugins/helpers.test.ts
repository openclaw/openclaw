import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  buildAccountScopedDmSecurityPolicy,
  formatPairingApproveHint,
  parseOptionalDelimitedEntries,
} from "./helpers.js";

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
