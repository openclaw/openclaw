import { describe, expect, it } from "vitest";
import { __testing } from "./monitor-provider.js";

describe("resolveIMessageRuntimeGroupPolicy", () => {
  it("fails closed when channels.imessage is missing and no defaults are set", () => {
    const resolved = __testing.resolveIMessageRuntimeGroupPolicy({
      providerConfigPresent: false,
    });
    expect(resolved.groupPolicy).toBe("allowlist");
    expect(resolved.providerMissingFallbackApplied).toBe(true);
  });

  it("keeps open fallback when channels.imessage is configured", () => {
    const resolved = __testing.resolveIMessageRuntimeGroupPolicy({
      providerConfigPresent: true,
    });
    expect(resolved.groupPolicy).toBe("open");
    expect(resolved.providerMissingFallbackApplied).toBe(false);
  });

  it("ignores explicit global defaults when provider config is missing", () => {
    const resolved = __testing.resolveIMessageRuntimeGroupPolicy({
      providerConfigPresent: false,
      defaultGroupPolicy: "disabled",
    });
    expect(resolved.groupPolicy).toBe("allowlist");
    expect(resolved.providerMissingFallbackApplied).toBe(true);
  });
});
