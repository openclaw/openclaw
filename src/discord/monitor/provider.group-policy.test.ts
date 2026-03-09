import { describe, expect, it } from "vitest";
import { __testing } from "./provider.js";

describe("resolveDiscordRuntimeGroupPolicy", () => {
  it("fails closed when channels.discord is missing and no defaults are set", () => {
    const resolved = __testing.resolveDiscordRuntimeGroupPolicy({
      providerConfigPresent: false,
    });
    expect(resolved.groupPolicy).toBe("allowlist");
    expect(resolved.providerMissingFallbackApplied).toBe(true);
  });

  it("keeps open default when channels.discord is configured", () => {
    const resolved = __testing.resolveDiscordRuntimeGroupPolicy({
      providerConfigPresent: true,
    });
    expect(resolved.groupPolicy).toBe("open");
    expect(resolved.providerMissingFallbackApplied).toBe(false);
  });

  it("respects explicit provider policy", () => {
    const resolved = __testing.resolveDiscordRuntimeGroupPolicy({
      providerConfigPresent: false,
      groupPolicy: "disabled",
    });
    expect(resolved.groupPolicy).toBe("disabled");
    expect(resolved.providerMissingFallbackApplied).toBe(false);
  });

  it("ignores explicit global defaults when provider config is missing", () => {
    const resolved = __testing.resolveDiscordRuntimeGroupPolicy({
      providerConfigPresent: false,
      defaultGroupPolicy: "open",
    });
    expect(resolved.groupPolicy).toBe("allowlist");
    expect(resolved.providerMissingFallbackApplied).toBe(true);
  });
});
