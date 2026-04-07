import { describe, expect, it } from "vitest";
import { collectEmptyAllowlistPolicyWarningsForAccount } from "./empty-allowlist-policy.js";

describe("doctor empty allowlist policy warnings", () => {
  it("warns when dm allowlist mode has no allowFrom entries", () => {
    const warnings = collectEmptyAllowlistPolicyWarningsForAccount({
      account: { dmPolicy: "allowlist" },
      channelName: "signal",
      doctorFixCommand: "openclaw doctor --fix",
      prefix: "channels.signal",
    });

    expect(warnings).toEqual([
      expect.stringContaining('channels.signal.dmPolicy is "allowlist" but allowFrom is empty'),
    ]);
  });

  it("warns when non-telegram group allowlist mode does not fall back to allowFrom", () => {
    const warnings = collectEmptyAllowlistPolicyWarningsForAccount({
      account: { groupPolicy: "allowlist" },
      channelName: "imessage",
      doctorFixCommand: "openclaw doctor --fix",
      prefix: "channels.imessage",
    });

    expect(warnings).toEqual([
      expect.stringContaining('channels.imessage.groupPolicy is "allowlist"'),
    ]);
  });

  it("stays quiet for zalouser hybrid route-and-sender group access", () => {
    const warnings = collectEmptyAllowlistPolicyWarningsForAccount({
      account: { groupPolicy: "allowlist" },
      channelName: "zalouser",
      doctorFixCommand: "openclaw doctor --fix",
      prefix: "channels.zalouser",
    });

    expect(warnings).toEqual([
      expect.stringContaining('channels.zalouser.groupPolicy is "allowlist"'),
    ]);
  });

  it("stays quiet for channels that do not use sender-based group allowlists", () => {
    const warnings = collectEmptyAllowlistPolicyWarningsForAccount({
      account: { groupPolicy: "allowlist" },
      channelName: "discord",
      doctorFixCommand: "openclaw doctor --fix",
      prefix: "channels.discord",
    });

    expect(warnings).toEqual([
      expect.stringContaining('channels.discord.groupPolicy is "allowlist"'),
    ]);
  });
});
