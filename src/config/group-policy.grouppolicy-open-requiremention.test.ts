import { describe, expect, test } from "vitest";
import type { OpenClawConfig } from "./config.js";
import { resolveChannelGroupRequireMention } from "./group-policy.js";

describe("Issue #33218: groupPolicy='open' should not require mention", () => {
  test("✅ FIXED: groupPolicy='open' with no requireMention config defaults to requireMention=false", () => {
    const config: OpenClawConfig = {
      channels: {
        telegram: {
          enabled: true,
          groupPolicy: "open",
          // No requireMention configured
        },
      },
    };

    const requireMention = resolveChannelGroupRequireMention({
      cfg: config,
      channel: "telegram",
      groupId: "-123456789",
    });

    console.log("✅ FIX VERIFIED:");
    console.log(`  groupPolicy: "open"`);
    console.log(`  requireMention config: undefined`);
    console.log(`  resolveChannelGroupRequireMention returns: ${requireMention}`);
    console.log(`  Expected: false (open policy should not require mention)`);
    console.log(`  Result: ${requireMention ? "❌ FAIL" : "✅ PASS"}`);

    // After fix: should return false
    expect(requireMention).toBe(false);
  });

  test("groupPolicy='allowlist' should default to requireMention=true", () => {
    const config: OpenClawConfig = {
      channels: {
        telegram: {
          enabled: true,
          groupPolicy: "allowlist",
        },
      },
    };

    const requireMention = resolveChannelGroupRequireMention({
      cfg: config,
      channel: "telegram",
      groupId: "-123456789",
    });

    // allowlist should require mention by default
    expect(requireMention).toBe(true);
  });

  test("explicit requireMention=false should override groupPolicy", () => {
    const config: OpenClawConfig = {
      channels: {
        telegram: {
          enabled: true,
          groupPolicy: "allowlist",
          groups: {
            "-123456789": {
              requireMention: false,
            },
          },
        },
      },
    };

    const requireMention = resolveChannelGroupRequireMention({
      cfg: config,
      channel: "telegram",
      groupId: "-123456789",
    });

    expect(requireMention).toBe(false);
  });
});
