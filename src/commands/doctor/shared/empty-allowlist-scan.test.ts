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

  it("does not warn about parent groupAllowFrom when every account overrides it", () => {
    const warnings = scanEmptyAllowlistPolicyWarnings(
      {
        channels: {
          signal: {
            dmPolicy: "open",
            groupPolicy: "allowlist",
            accounts: {
              work: {
                groupPolicy: "allowlist",
                groupAllowFrom: ["+1234567890"],
              },
              personal: {
                groupPolicy: "allowlist",
                groupAllowFrom: ["+1987654321"],
              },
            },
          },
        },
      },
      { doctorFixCommand: "openclaw doctor --fix" },
    );

    // Parent has empty groupAllowFrom, but every account has its own populated
    // groupAllowFrom — runtime never reads the parent. No warnings expected.
    expect(warnings).toStrictEqual([]);
  });

  it("still warns about parent groupAllowFrom when some accounts lack it", () => {
    const warnings = scanEmptyAllowlistPolicyWarnings(
      {
        channels: {
          signal: {
            groupPolicy: "allowlist",
            accounts: {
              work: {
                groupPolicy: "allowlist",
                groupAllowFrom: ["+1234567890"],
              },
              personal: {
                groupPolicy: "allowlist",
                // No groupAllowFrom — will fall back to parent
              },
            },
          },
        },
      },
      { doctorFixCommand: "openclaw doctor --fix" },
    );

    // One account lacks its own groupAllowFrom, so the parent fallback matters.
    // The personal account also gets its own per-account warning.
    expect(warnings).toStrictEqual([
      '- channels.signal.groupPolicy is "allowlist" but groupAllowFrom (and allowFrom) is empty — all group messages will be silently dropped. Add sender IDs to channels.signal.groupAllowFrom or channels.signal.allowFrom, or set groupPolicy to "open".',
      '- channels.signal.accounts.personal.groupPolicy is "allowlist" but groupAllowFrom (and allowFrom) is empty — all group messages will be silently dropped. Add sender IDs to channels.signal.accounts.personal.groupAllowFrom or channels.signal.accounts.personal.allowFrom, or set groupPolicy to "open".',
    ]);
  });

  it("suppresses parent warning when all accounts have allowFrom with fallback enabled", () => {
    const warnings = scanEmptyAllowlistPolicyWarnings(
      {
        channels: {
          signal: {
            dmPolicy: "open",
            groupPolicy: "allowlist",
            accounts: {
              work: {
                groupPolicy: "allowlist",
                // No groupAllowFrom, but signal allows fallback to allowFrom
                allowFrom: ["+1234567890"],
              },
              personal: {
                groupPolicy: "allowlist",
                allowFrom: ["+1987654321"],
              },
            },
          },
        },
      },
      { doctorFixCommand: "openclaw doctor --fix" },
    );

    // signal has groupAllowFromFallbackToAllowFrom=true, so account-level
    // allowFrom serves as effective group sender allowlist. No warning expected.
    expect(warnings).toStrictEqual([]);
  });

  it("does not suppress parent warning when accounts have allowFrom but fallback is disabled", () => {
    const warnings = scanEmptyAllowlistPolicyWarnings(
      {
        channels: {
          imessage: {
            groupPolicy: "allowlist",
            accounts: {
              work: {
                groupPolicy: "allowlist",
                // imessage has groupAllowFromFallbackToAllowFrom=false
                allowFrom: ["+1234567890"],
              },
            },
          },
        },
      },
      { doctorFixCommand: "openclaw doctor --fix" },
    );

    // imessage doesn't allow fallback, so account allowFrom does not override
    // the parent groupAllowFrom. Parent warning should still fire, and the
    // work account also gets a per-account warning since its allowFrom is
    // not a valid group allowlist source for non-fallback channels.
    expect(warnings).toStrictEqual([
      '- channels.imessage.groupPolicy is "allowlist" but groupAllowFrom is empty — this channel does not fall back to allowFrom, so all group messages will be silently dropped. Add sender IDs to channels.imessage.groupAllowFrom, or set groupPolicy to "open".',
      '- channels.imessage.accounts.work.groupPolicy is "allowlist" but groupAllowFrom is empty — this channel does not fall back to allowFrom, so all group messages will be silently dropped. Add sender IDs to channels.imessage.accounts.work.groupAllowFrom, or set groupPolicy to "open".',
    ]);
  });

  it("suppresses parent warning when enabled accounts override and disabled account does not", () => {
    const warnings = scanEmptyAllowlistPolicyWarnings(
      {
        channels: {
          signal: {
            dmPolicy: "open",
            groupPolicy: "allowlist",
            accounts: {
              work: {
                groupPolicy: "allowlist",
                groupAllowFrom: ["+1234567890"],
              },
              personal: {
                enabled: false,
                groupPolicy: "allowlist",
                // No groupAllowFrom, but disabled — doesn't count against override
              },
            },
          },
        },
      },
      { doctorFixCommand: "openclaw doctor --fix" },
    );

    // Disabled accounts are excluded from the override check, so the parent
    // warning is suppressed even though the disabled account has no allowlist.
    expect(warnings).toStrictEqual([]);
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
});
