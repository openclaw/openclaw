import { describe, expect, it } from "vitest";
import { normalizeNonTelegramGroupPolicy } from "../../config/runtime-group-policy.js";
import { installProviderRuntimeGroupPolicyFallbackSuite } from "../../test-utils/runtime-group-policy-contract.js";
import { isDiscordGroupAllowedByPolicy } from "./allow-list.js";
import { __testing } from "./provider.js";

describe("resolveDiscordRuntimeGroupPolicy", () => {
  installProviderRuntimeGroupPolicyFallbackSuite({
    resolve: __testing.resolveDiscordRuntimeGroupPolicy,
    configuredLabel: "keeps open default when channels.discord is configured",
    defaultGroupPolicyUnderTest: "open",
    missingConfigLabel: "fails closed when channels.discord is missing and no defaults are set",
    missingDefaultLabel: "ignores explicit global defaults when provider config is missing",
  });

  it("respects explicit provider policy", () => {
    const resolved = __testing.resolveDiscordRuntimeGroupPolicy({
      providerConfigPresent: false,
      groupPolicy: "disabled",
    });
    expect(resolved.groupPolicy).toBe("disabled");
    expect(resolved.providerMissingFallbackApplied).toBe(false);
  });
});

describe("groupPolicy 'members' normalization for Discord preflight", () => {
  it("normalizes 'members' to 'open' so guild messages are allowed", () => {
    // "members" is Telegram-only; for Discord it must normalize to "open" so
    // that guild messages pass the policy gate rather than being blocked.
    const normalized = normalizeNonTelegramGroupPolicy("members");
    expect(normalized).toBe("open");

    const allowed = isDiscordGroupAllowedByPolicy({
      groupPolicy: normalized,
      guildAllowlisted: false,
      channelAllowlistConfigured: false,
      channelAllowed: false,
    });
    expect(allowed).toBe(true);
  });

  it("normalized 'members' through full policy resolution allows guild messages", () => {
    // Simulate: provider configured, groupPolicy="members" explicitly set.
    const resolved = __testing.resolveDiscordRuntimeGroupPolicy({
      providerConfigPresent: true,
      groupPolicy: "members",
    });
    // resolveDiscordRuntimeGroupPolicy returns the raw policy; normalization happens next.
    const normalized = normalizeNonTelegramGroupPolicy(resolved.groupPolicy);
    expect(normalized).toBe("open");

    const allowed = isDiscordGroupAllowedByPolicy({
      groupPolicy: normalized,
      guildAllowlisted: false,
      channelAllowlistConfigured: false,
      channelAllowed: false,
    });
    expect(allowed).toBe(true);
  });
});
