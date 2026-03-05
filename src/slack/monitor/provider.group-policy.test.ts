import { describe, expect, it } from "vitest";
import { __testing } from "./provider.js";

describe("resolveSlackRuntimeGroupPolicy", () => {
  it("fails closed when channels.slack is missing and no defaults are set", () => {
    const resolved = __testing.resolveSlackRuntimeGroupPolicy({
      providerConfigPresent: false,
    });
    expect(resolved.groupPolicy).toBe("allowlist");
    expect(resolved.providerMissingFallbackApplied).toBe(true);
  });

  it("keeps open default when channels.slack is configured", () => {
    const resolved = __testing.resolveSlackRuntimeGroupPolicy({
      providerConfigPresent: true,
    });
    expect(resolved.groupPolicy).toBe("open");
    expect(resolved.providerMissingFallbackApplied).toBe(false);
  });

  it("ignores explicit global defaults when provider config is missing", () => {
    const resolved = __testing.resolveSlackRuntimeGroupPolicy({
      providerConfigPresent: false,
      defaultGroupPolicy: "open",
    });
    expect(resolved.groupPolicy).toBe("allowlist");
    expect(resolved.providerMissingFallbackApplied).toBe(true);
  });
});
