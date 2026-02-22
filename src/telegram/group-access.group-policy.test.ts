import { describe, expect, it } from "vitest";
import { resolveTelegramRuntimeGroupPolicy } from "./group-access.js";

describe("resolveTelegramRuntimeGroupPolicy", () => {
  it("fails closed when channels.telegram is missing and no defaults are set", () => {
    const resolved = resolveTelegramRuntimeGroupPolicy({
      providerConfigPresent: false,
    });
    expect(resolved.groupPolicy).toBe("allowlist");
    expect(resolved.providerMissingFallbackApplied).toBe(true);
  });

  it("keeps open fallback when channels.telegram is configured", () => {
    const resolved = resolveTelegramRuntimeGroupPolicy({
      providerConfigPresent: true,
    });
    expect(resolved.groupPolicy).toBe("open");
    expect(resolved.providerMissingFallbackApplied).toBe(false);
  });

  it("ignores explicit defaults when provider config is missing", () => {
    const resolved = resolveTelegramRuntimeGroupPolicy({
      providerConfigPresent: false,
      defaultGroupPolicy: "disabled",
    });
    expect(resolved.groupPolicy).toBe("allowlist");
    expect(resolved.providerMissingFallbackApplied).toBe(true);
  });
});
