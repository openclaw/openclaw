import { describe, expect, it } from "vitest";
import { resolveRuntimeGroupPolicy } from "./runtime-group-policy.js";

describe("resolveRuntimeGroupPolicy", () => {
  it("fails closed when provider config is missing and no defaults are set", () => {
    const resolved = resolveRuntimeGroupPolicy({
      providerConfigPresent: false,
    });
    expect(resolved.groupPolicy).toBe("allowlist");
    expect(resolved.providerMissingFallbackApplied).toBe(true);
  });

  it("keeps configured fallback when provider config is present", () => {
    const resolved = resolveRuntimeGroupPolicy({
      providerConfigPresent: true,
      configuredFallbackPolicy: "open",
    });
    expect(resolved.groupPolicy).toBe("open");
    expect(resolved.providerMissingFallbackApplied).toBe(false);
  });

  it("ignores global defaults when provider config is missing", () => {
    const resolved = resolveRuntimeGroupPolicy({
      providerConfigPresent: false,
      defaultGroupPolicy: "disabled",
      configuredFallbackPolicy: "open",
      missingProviderFallbackPolicy: "allowlist",
    });
    expect(resolved.groupPolicy).toBe("allowlist");
    expect(resolved.providerMissingFallbackApplied).toBe(true);
  });
});
