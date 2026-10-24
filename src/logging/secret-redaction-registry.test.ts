// Registry tests cover the longest registered length across registration, eviction and reset.
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

describe("longest registered secret length", () => {
  it("follows registration, eviction of the oldest value at 512, and reset", () => {
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
});
