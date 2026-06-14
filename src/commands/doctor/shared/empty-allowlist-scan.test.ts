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

  it("does not warn on empty top-level groupAllowFrom when every account has its own populated list", () => {
    // Reporter scenario from #92684: top-level groupAllowFrom is empty but
    // each account carries its own populated groupAllowFrom. The top-level
    // config is only a parent/fallback, not an account, and should not
    // trigger a false "all group messages dropped" warning.
    const warnings = scanEmptyAllowlistPolicyWarnings(
      {
        channels: {
          telegram: {
            groupPolicy: "allowlist",
            groupAllowFrom: [],
            accounts: {
              bot1: {
                groupAllowFrom: ["@alice"],
              },
              bot2: {
                groupAllowFrom: ["@bob"],
              },
            },
          },
        },
      },
      { doctorFixCommand: "openclaw doctor --fix" },
    );
    // The top-level parent config must not be scanned as a standalone account.
    expect(warnings.filter((w) => w.includes("group messages")).length).toBe(0);
  });

  it("still warns on empty top-level groupAllowFrom when no accounts are configured", () => {
    // Regression: without sub-accounts, the top-level config is the account
    // and empty groupAllowFrom is a real problem.
    const warnings = scanEmptyAllowlistPolicyWarnings(
      {
        channels: {
          telegram: {
            groupPolicy: "allowlist",
          },
        },
      },
      { doctorFixCommand: "openclaw doctor --fix" },
    );
    expect(warnings.some((w) => w.includes("group messages"))).toBe(true);
  });

  it("still warns when the default account is present even if named accounts have own allowFrom", () => {
    // When the `default` account exists, the top-level is also an active
    // account (not just a parent). The parent warning must still fire.
    const warnings = scanEmptyAllowlistPolicyWarnings(
      {
        channels: {
          telegram: {
            groupPolicy: "allowlist",
            groupAllowFrom: [],
            accounts: {
              default: {
                groupAllowFrom: ["@defaultUser"],
              },
              bot1: {
                groupAllowFrom: ["@alice"],
              },
            },
          },
        },
      },
      { doctorFixCommand: "openclaw doctor --fix" },
    );
    expect(warnings.some((w) => w.includes("group messages"))).toBe(true);
  });

  it("still warns when a root default account coexists with named accounts and lacks its own allowFrom", () => {
    // Regression: the root `default` account IS an active account, not just
    // a parent/fallback. If it doesn't have its own groupAllowFrom, the
    // top-level warning must still fire.
    const warnings = scanEmptyAllowlistPolicyWarnings(
      {
        channels: {
          telegram: {
            groupPolicy: "allowlist",
            groupAllowFrom: [],
            accounts: {
              default: {
                // No groupAllowFrom of its own — relies on top-level
                allowFrom: [],
              },
              bot1: {
                groupAllowFrom: ["@alice"],
              },
            },
          },
        },
      },
      { doctorFixCommand: "openclaw doctor --fix" },
    );
    // The `default` account has no groupAllowFrom, so the top-level warning is still relevant.
    expect(warnings.some((w) => w.includes("group messages"))).toBe(true);
  });
});
