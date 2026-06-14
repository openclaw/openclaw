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

  it("does not warn on empty top-level groupAllowFrom when sub-accounts are present", () => {
    // Reporter scenario from #92684: top-level groupAllowFrom is empty,
    // sub-accounts exist, and the top-level has no allowFrom of its own.
    // The top-level is a parent/fallback, not an account — no false warning.
    const warnings = scanEmptyAllowlistPolicyWarnings(
      {
        channels: {
          telegram: {
            groupPolicy: "allowlist",
            groupAllowFrom: [],
            accounts: {
              bot1: { groupAllowFrom: ["@alice"] },
              bot2: { groupAllowFrom: ["@bob"] },
            },
          },
        },
      },
      { doctorFixCommand: "openclaw doctor --fix" },
    );
    expect(warnings.filter((w) => w.includes("group messages")).length).toBe(0);
  });

  it("does not warn when top-level has own populated groupAllowFrom with sub-accounts", () => {
    // The top-level has its own groupAllowFrom entries — it has an effective
    // allowlist, so no "empty" warning should fire for the parent scope.
    const warnings = scanEmptyAllowlistPolicyWarnings(
      {
        channels: {
          telegram: {
            groupPolicy: "allowlist",
            groupAllowFrom: ["@owner"],
            accounts: {
              bot1: { groupAllowFrom: ["@alice"] },
            },
          },
        },
      },
      { doctorFixCommand: "openclaw doctor --fix" },
    );
    expect(warnings.filter((w) => w.includes("group messages")).length).toBe(0);
  });

  it("still warns when top-level has botToken credentials with named accounts", () => {
    // Top-level botToken creates an implicit default account. Even though
    // named accounts have their own allowFrom, the implicit default account
    // uses the top-level's empty groupAllowFrom — warning must fire.
    const warnings = scanEmptyAllowlistPolicyWarnings(
      {
        channels: {
          telegram: {
            botToken: "123:abc",
            groupPolicy: "allowlist",
            groupAllowFrom: [],
            accounts: {
              bot1: { groupAllowFrom: ["@alice"] },
            },
          },
        },
      },
      { doctorFixCommand: "openclaw doctor --fix" },
    );
    expect(warnings.some((w) => w.includes("group messages"))).toBe(true);
  });

  it("still warns on empty top-level groupAllowFrom when no accounts are configured", () => {
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
});
