import { describe, expect, it } from "vitest";
import { collectTelegramGroupPolicyWarnings } from "./telegram.js";

describe("doctor telegram provider warnings", () => {
  it("shows first-run guidance when groups are not configured yet", () => {
    const warnings = collectTelegramGroupPolicyWarnings({
      account: {
        botToken: "123:abc",
        groupPolicy: "allowlist",
      },
      prefix: "channels.telegram",
      dmPolicy: "pairing",
    });

    expect(warnings).toEqual([
      expect.stringContaining("channels.telegram: Telegram is in first-time setup mode."),
    ]);
    expect(warnings[0]).toContain("DMs use pairing mode");
    expect(warnings[0]).toContain("channels.telegram.groups");
  });

  it("warns when configured groups still have no usable sender allowlist", () => {
    const warnings = collectTelegramGroupPolicyWarnings({
      account: {
        botToken: "123:abc",
        groupPolicy: "allowlist",
        groups: {
          ops: { allow: true },
        },
      },
      prefix: "channels.telegram",
    });

    expect(warnings).toEqual([
      expect.stringContaining(
        'channels.telegram.groupPolicy is "allowlist" but groupAllowFrom (and allowFrom) is empty',
      ),
    ]);
  });

  it("stays quiet when allowFrom can satisfy group allowlist mode", () => {
    const warnings = collectTelegramGroupPolicyWarnings({
      account: {
        botToken: "123:abc",
        groupPolicy: "allowlist",
        groups: {
          ops: { allow: true },
        },
      },
      prefix: "channels.telegram",
      effectiveAllowFrom: ["123456"],
    });

    expect(warnings).toEqual([]);
  });
});
