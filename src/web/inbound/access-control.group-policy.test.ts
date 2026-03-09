import { describe, expect, it } from "vitest";
import { __testing } from "./access-control.js";

describe("resolveWhatsAppRuntimeGroupPolicy", () => {
  it("fails closed when channels.whatsapp is missing and no defaults are set", () => {
    const resolved = __testing.resolveWhatsAppRuntimeGroupPolicy({
      providerConfigPresent: false,
    });
    expect(resolved.groupPolicy).toBe("allowlist");
    expect(resolved.providerMissingFallbackApplied).toBe(true);
  });

  it("keeps open fallback when channels.whatsapp is configured", () => {
    const resolved = __testing.resolveWhatsAppRuntimeGroupPolicy({
      providerConfigPresent: true,
    });
    expect(resolved.groupPolicy).toBe("open");
    expect(resolved.providerMissingFallbackApplied).toBe(false);
  });

  it("ignores explicit default policy when provider config is missing", () => {
    const resolved = __testing.resolveWhatsAppRuntimeGroupPolicy({
      providerConfigPresent: false,
      defaultGroupPolicy: "disabled",
    });
    expect(resolved.groupPolicy).toBe("allowlist");
    expect(resolved.providerMissingFallbackApplied).toBe(true);
  });
});
