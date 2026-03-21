import { describe, expect, it } from "vitest";
import {
  collectTelegramEmptyAllowlistExtraWarnings,
  collectTelegramGroupPolicyWarnings,
  scanTelegramAllowFromUsernameEntries,
} from "./telegram.js";

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

  it("returns extra empty-allowlist warnings only for telegram allowlist groups", () => {
    const warnings = collectTelegramEmptyAllowlistExtraWarnings({
      account: {
        botToken: "123:abc",
        groupPolicy: "allowlist",
        groups: {
          ops: { allow: true },
        },
      },
      channelName: "telegram",
      prefix: "channels.telegram",
    });

    expect(warnings).toEqual([
      expect.stringContaining(
        'channels.telegram.groupPolicy is "allowlist" but groupAllowFrom (and allowFrom) is empty',
      ),
    ]);
    expect(
      collectTelegramEmptyAllowlistExtraWarnings({
        account: { groupPolicy: "allowlist" },
        channelName: "signal",
        prefix: "channels.signal",
      }),
    ).toEqual([]);
  });

  it("finds non-numeric telegram allowFrom username entries across account scopes", () => {
    const hits = scanTelegramAllowFromUsernameEntries({
      channels: {
        telegram: {
          allowFrom: ["@top"],
          groupAllowFrom: ["12345"],
          accounts: {
            work: {
              allowFrom: ["tg:@work"],
              groups: {
                "-100123": {
                  allowFrom: ["topic-user"],
                  topics: {
                    "99": {
                      allowFrom: ["777", "@topic-user"],
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    expect(hits).toEqual([
      { path: "channels.telegram.allowFrom", entry: "@top" },
      { path: "channels.telegram.accounts.work.allowFrom", entry: "tg:@work" },
      { path: "channels.telegram.accounts.work.groups.-100123.allowFrom", entry: "topic-user" },
      {
        path: "channels.telegram.accounts.work.groups.-100123.topics.99.allowFrom",
        entry: "@topic-user",
      },
    ]);
  });
});
