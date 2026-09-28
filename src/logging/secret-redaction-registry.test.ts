// Registry tests cover bounded eviction of registered exact secret values.
import { afterEach, describe, expect, it } from "vitest";
import { redactSensitiveText } from "./redact.js";
import {
  getLongestRegisteredSecretLength,
  registerSecretValueForRedaction,
} from "./secret-redaction-registry.js";
import { resetSecretRedactionRegistryForTest } from "./secret-redaction-registry.test-support.js";

afterEach(() => {
  resetSecretRedactionRegistryForTest();
});

describe("registered exact secret value eviction", () => {
  it("evicts the oldest value after 512 registrations", () => {
    // The oldest value is also the longest, so eviction must shorten the longest length.
    const first = "exact-registry-value-000-longest";
    registerSecretValueForRedaction(first);
    expect(getLongestRegisteredSecretLength()).toBe(first.length);
    for (let index = 1; index <= 512; index += 1) {
      registerSecretValueForRedaction(`exact-registry-value-${index.toString().padStart(3, "0")}`);
    }
    const last = "exact-registry-value-512";

    expect(redactSensitiveText(first, { mode: "off" })).toBe(first);
    expect(redactSensitiveText(last, { mode: "off" })).toBe("exact-…-512");
    expect(getLongestRegisteredSecretLength()).toBe(last.length);
    resetSecretRedactionRegistryForTest();
    expect(getLongestRegisteredSecretLength()).toBe(0);
  });

  it("refreshes duplicate registration recency before eviction", () => {
    const first = "exact-registry-refresh-000";
    const second = "exact-registry-refresh-001";
    for (let index = 0; index < 512; index += 1) {
      registerSecretValueForRedaction(
        `exact-registry-refresh-${index.toString().padStart(3, "0")}`,
      );
    }
    registerSecretValueForRedaction(first);
    registerSecretValueForRedaction("exact-registry-refresh-512");

    expect(redactSensitiveText(first, { mode: "off" })).not.toContain(first);
    expect(redactSensitiveText(second, { mode: "off" })).toBe(second);
  });
});
