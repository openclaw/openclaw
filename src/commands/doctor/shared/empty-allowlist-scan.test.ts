// Empty allowlist scan tests cover doctor detection of unconfigured sender allowlists.
import { describe, expect, it, vi } from "vitest";
import { scanEmptyAllowlistPolicyWarnings } from "./empty-allowlist-scan.js";

vi.mock("../channel-capabilities.js", () => ({
  getDoctorChannelCapabilities: (channelName?: string) => ({
    dmAllowFromMode: "topOnly",
    groupModel: "sender",
    groupAllowFromFallbackToAllowFrom: channelName !== "imessage",
    warnOnEmptyGroupSenderAllowlist: channelName !== "discord",
  }),
}));

vi.mock("./channel-doctor.js", () => ({
  shouldSkipChannelDoctorDefaultEmptyGroupAllowlistWarning: () => false,
}));

describe("doctor empty allowlist policy scan", () => {
  it("scans top-level and account-scoped channel warnings", () => {
    const warnings = scanEmptyAllowlistPolicyWarnings(
      {
        channels: {
          signal: {
            dmPolicy: "allowlist",
            accounts: {
              work: { dmPolicy: "allowlist" },
            },
          },
        },
      },
      { doctorFixCommand: "openclaw doctor --fix" },
    );

    expect(warnings).toEqual([
      '- channels.signal.dmPolicy is "allowlist" but allowFrom is empty — all DMs will be blocked. Add sender IDs to channels.signal.allowFrom, or run "openclaw doctor --fix" to auto-migrate from pairing store when entries exist.',
      '- channels.signal.accounts.work.dmPolicy is "allowlist" but allowFrom is empty — all DMs will be blocked. Add sender IDs to channels.signal.accounts.work.allowFrom, or run "openclaw doctor --fix" to auto-migrate from pairing store when entries exist.',
    ]);
  });

  it("allows provider-specific extra warnings without importing providers", () => {
    const warnings = scanEmptyAllowlistPolicyWarnings(
      {
        channels: {
          telegram: {
            groupPolicy: "allowlist",
          },
        },
      },
      {
        doctorFixCommand: "openclaw doctor --fix",
        extraWarningsForAccount: ({ channelName, prefix }) =>
          channelName === "telegram" ? [`extra:${prefix}`] : [],
      },
    );

    expect(warnings).toStrictEqual([
      '- channels.telegram.groupPolicy is "allowlist" but groupAllowFrom (and allowFrom) is empty — all group messages will be silently dropped. Add sender IDs to channels.telegram.groupAllowFrom or channels.telegram.allowFrom, or set groupPolicy to "open".',
      "extra:channels.telegram",
    ]);
  });

  it("skips disabled channel and account entries", () => {
    const extraWarningsForAccount = vi.fn(({ prefix }) => [`extra:${prefix}`]);

    const warnings = scanEmptyAllowlistPolicyWarnings(
      {
        channels: {
          telegram: {
            enabled: false,
            dmPolicy: "allowlist",
            accounts: {
              default: { dmPolicy: "allowlist" },
            },
          },
          signal: {
            accounts: {
              disabled: { enabled: false, dmPolicy: "allowlist" },
            },
          },
        },
      },
      { doctorFixCommand: "openclaw doctor --fix", extraWarningsForAccount },
    );

    expect(warnings).toEqual(["extra:channels.signal"]);
    expect(extraWarningsForAccount).toHaveBeenCalledTimes(1);
    const [warningOptions] = extraWarningsForAccount.mock.calls[0] ?? [];
    expect(warningOptions?.prefix).toBe("channels.signal");
  });

  it("does not warn on top-level groupAllowFrom when every account has its own allowlist (regression #92684)", () => {
    const warnings = scanEmptyAllowlistPolicyWarnings(
      {
        channels: {
          telegram: {
            groupPolicy: "allowlist",
            groupAllowFrom: [],
            accounts: {
              default: { groupAllowFrom: ["user-123"] },
              work: { groupAllowFrom: ["user-456"] },
            },
          },
        },
      },
      { doctorFixCommand: "openclaw doctor --fix" },
    );

    // No warnings should be emitted because every account has its own populated groupAllowFrom.
    expect(warnings).toEqual([]);
  });

  it("does not warn on top-level groupAllowFrom when every account has allowFrom fallback", () => {
    const warnings = scanEmptyAllowlistPolicyWarnings(
      {
        channels: {
          telegram: {
            groupPolicy: "allowlist",
            groupAllowFrom: [],
            accounts: {
              default: { allowFrom: ["user-123"] },
              work: { allowFrom: ["user-456"] },
            },
          },
        },
      },
      { doctorFixCommand: "openclaw doctor --fix" },
    );

    // No warnings should be emitted because every account has its own populated allowFrom.
    expect(warnings).toEqual([]);
  });

  it("does not warn when top-level has credentials and accounts have allowlists", () => {
    const warnings = scanEmptyAllowlistPolicyWarnings(
      {
        channels: {
          telegram: {
            groupPolicy: "allowlist",
            groupAllowFrom: [],
            botToken: "bot-token",
            accounts: {
              default: { groupAllowFrom: ["user-123"] },
              work: { groupAllowFrom: ["user-456"] },
            },
          },
        },
      },
      { doctorFixCommand: "openclaw doctor --fix" },
    );

    // No warnings because every enabled account covers the policy.
    expect(warnings).toEqual([]);
  });

  it("skips disabled accounts when checking coverage", () => {
    const warnings = scanEmptyAllowlistPolicyWarnings(
      {
        channels: {
          telegram: {
            groupPolicy: "allowlist",
            groupAllowFrom: [],
            accounts: {
              default: { groupAllowFrom: ["user-123"] },
              disabled: { enabled: false, groupAllowFrom: [] },
            },
          },
        },
      },
      { doctorFixCommand: "openclaw doctor --fix" },
    );

    // No warnings because the disabled account is skipped and the enabled one covers the policy.
    expect(warnings).toEqual([]);
  });

  it("warns when Telegram has botToken but no default account allowlist", () => {
    const warnings = scanEmptyAllowlistPolicyWarnings(
      {
        channels: {
          telegram: {
            groupPolicy: "allowlist",
            groupAllowFrom: [],
            botToken: "bot-token",
            accounts: {
              work: { groupAllowFrom: ["user-456"] },
            },
          },
        },
      },
      { doctorFixCommand: "openclaw doctor --fix" },
    );

    // Should warn because the implicit default account (from botToken) has no allowlist.
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain("groupAllowFrom");
  });
});
