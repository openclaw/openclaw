import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { buildAccountScopedDmSecurityPolicy, formatPairingApproveHint } from "./helpers.js";

function cfgWithChannel(channelKey: string, accounts?: Record<string, unknown>): OpenClawConfig {
  return {
    channels: {
      [channelKey]: accounts ? { accounts } : {},
    },
  } as unknown as OpenClawConfig;
}

describe("buildAccountScopedDmSecurityPolicy", () => {
  it("builds top-level dm policy paths when no account config exists", () => {
    expect(
      buildAccountScopedDmSecurityPolicy({
        cfg: cfgWithChannel("telegram"),
        channelKey: "telegram",
        fallbackAccountId: "default",
        policy: "pairing",
        allowFrom: ["123"],
        policyPathSuffix: "dmPolicy",
      }),
    ).toEqual({
      policy: "pairing",
      allowFrom: ["123"],
      policyPath: "channels.telegram.dmPolicy",
      allowFromPath: "channels.telegram.",
      approveHint: formatPairingApproveHint("telegram"),
      normalizeEntry: undefined,
    });
  });

  it("uses account-scoped paths when account config exists", () => {
    expect(
      buildAccountScopedDmSecurityPolicy({
        cfg: cfgWithChannel("signal", { work: {} }),
        channelKey: "signal",
        accountId: "work",
        fallbackAccountId: "default",
        policy: "allowlist",
        allowFrom: ["+12125551212"],
        policyPathSuffix: "dmPolicy",
      }),
    ).toEqual({
      policy: "allowlist",
      allowFrom: ["+12125551212"],
      policyPath: "channels.signal.accounts.work.dmPolicy",
      allowFromPath: "channels.signal.accounts.work.",
      approveHint: formatPairingApproveHint("signal"),
      normalizeEntry: undefined,
    });
  });

  it("supports nested dm paths without explicit policyPath", () => {
    expect(
      buildAccountScopedDmSecurityPolicy({
        cfg: cfgWithChannel("discord", { work: {} }),
        channelKey: "discord",
        accountId: "work",
        policy: "pairing",
        allowFrom: [],
        allowFromPathSuffix: "dm.",
      }),
    ).toEqual({
      policy: "pairing",
      allowFrom: [],
      policyPath: undefined,
      allowFromPath: "channels.discord.accounts.work.dm.",
      approveHint: formatPairingApproveHint("discord"),
      normalizeEntry: undefined,
    });
  });

  it("supports custom defaults and approve hints", () => {
    expect(
      buildAccountScopedDmSecurityPolicy({
        cfg: cfgWithChannel("synology-chat"),
        channelKey: "synology-chat",
        fallbackAccountId: "default",
        allowFrom: ["user-1"],
        defaultPolicy: "allowlist",
        policyPathSuffix: "dmPolicy",
        approveHint: "openclaw pairing approve synology-chat <code>",
      }),
    ).toEqual({
      policy: "allowlist",
      allowFrom: ["user-1"],
      policyPath: "channels.synology-chat.dmPolicy",
      allowFromPath: "channels.synology-chat.",
      approveHint: "openclaw pairing approve synology-chat <code>",
      normalizeEntry: undefined,
    });
  });
});
