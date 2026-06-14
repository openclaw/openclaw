// Evidence test for #92684: top-level groupAllowFrom should not warn
// when all sub-accounts have their own groupAllowFrom populated.
import { describe, expect, it, vi } from "vitest";
import { scanEmptyAllowlistPolicyWarnings } from "./empty-allowlist-scan.js";

vi.mock("../channel-capabilities.js", () => ({
  getDoctorChannelCapabilities: (channelName?: string) => ({
    dmAllowFromMode: "topOnly",
    groupModel: "sender",
    groupAllowFromFallbackToAllowFrom: true,
    warnOnEmptyGroupSenderAllowlist: channelName !== "discord",
  }),
}));

vi.mock("./channel-doctor.js", () => ({
  shouldSkipChannelDoctorDefaultEmptyGroupAllowlistWarning: () => false,
}));

describe("#92684 false positive group allowlist warning", () => {
  it("no top-level group warning when all accounts have their own groupAllowFrom", () => {
    const warnings = scanEmptyAllowlistPolicyWarnings(
      {
        channels: {
          telegram: {
            groupPolicy: "allowlist",
            groupAllowFrom: [], // empty top-level
            accounts: {
              work: { groupAllowFrom: [{ sender: "@friend1" }] },
              personal: { groupAllowFrom: [{ sender: "@friend2" }] },
            },
          },
        },
      },
      { doctorFixCommand: "openclaw doctor --fix" },
    );

    const topLevelGroupWarnings = warnings.filter(
      (w) => w.includes("groupPolicy") && !w.includes("accounts."),
    );
    // After fix: should be 0 — no false positive
    expect(topLevelGroupWarnings).toHaveLength(0);
  });

  it("still warns when no accounts exist (top-level is the only config)", () => {
    const warnings = scanEmptyAllowlistPolicyWarnings(
      {
        channels: {
          telegram: {
            groupPolicy: "allowlist",
            groupAllowFrom: [],
          },
        },
      },
      { doctorFixCommand: "openclaw doctor --fix" },
    );

    const topLevelGroupWarnings = warnings.filter(
      (w) => w.includes("groupPolicy") && !w.includes("accounts."),
    );
    // Without any accounts, top-level group warning should still fire
    expect(topLevelGroupWarnings.length).toBeGreaterThan(0);
  });

  it("still warns when some accounts lack groupAllowFrom (fallback needed)", () => {
    const warnings = scanEmptyAllowlistPolicyWarnings(
      {
        channels: {
          telegram: {
            groupPolicy: "allowlist",
            groupAllowFrom: [],
            accounts: {
              work: { groupAllowFrom: [{ sender: "@friend1" }] },
              personal: {}, // no groupAllowFrom — falls back to empty top-level
            },
          },
        },
      },
      { doctorFixCommand: "openclaw doctor --fix" },
    );

    const topLevelGroupWarnings = warnings.filter(
      (w) => w.includes("groupPolicy") && !w.includes("accounts."),
    );
    // Top-level group warning should still fire because 'personal' falls back
    expect(topLevelGroupWarnings.length).toBeGreaterThan(0);
  });
});
