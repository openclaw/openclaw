import { describe, it, expect, beforeEach } from "vitest";
import {
  redactSensitiveText,
  addSensitiveValue,
  addSensitiveValues,
  clearDynamicSensitiveValues,
  getDynamicSensitiveValuesCount,
} from "./redact.js";

describe("redactSensitiveText with dynamic values", () => {
  beforeEach(() => {
    clearDynamicSensitiveValues();
  });

  it("should redact sk- prefixed API keys", () => {
    const text = "API key: sk-3hjd98348hfkwduy83e4iuhfsa7t5623";
    const redacted = redactSensitiveText(text);
    expect(redacted).toContain("sk-3");
    expect(redacted).toContain("623");
    expect(redacted).toContain("…");
    expect(redacted).not.toContain("sk-3hjd98348hfkwduy83e4iuhfsa7t5623");
  });

  it("should redact GitHub personal access tokens", () => {
    const text = "Token: ghp_1234567890abcdefghij1234567890";
    const redacted = redactSensitiveText(text);
    expect(redacted).toContain("ghp_");
    expect(redacted).toContain("890");
    expect(redacted).not.toContain("ghp_1234567890abcdefghij1234567890");
  });

  it("should redact dynamically added sensitive values", () => {
    const secret = "test-secret-api-key-987654321098";
    addSensitiveValue(secret);

    expect(getDynamicSensitiveValuesCount()).toBeGreaterThan(0);

    const text = `Using key: ${secret}`;
    const redacted = redactSensitiveText(text);

    // Verify the secret is redacted (either format is acceptable)
    expect(redacted).not.toContain(secret);
    expect(redacted).not.toBe(text); // Must be different from original
  });

  it("should add multiple sensitive values at once", () => {
    const secrets = ["secret-key-number-one-123456", "secret-key-number-two-789012"];
    addSensitiveValues(secrets);

    expect(getDynamicSensitiveValuesCount()).toBe(2);

    const text = `First: ${secrets[0]}, Second: ${secrets[1]}`;
    const redacted = redactSensitiveText(text);

    expect(redacted).not.toContain(secrets[0]);
    expect(redacted).not.toContain(secrets[1]);
  });

  it("should not add values shorter than minimum length", () => {
    addSensitiveValue("short");
    expect(getDynamicSensitiveValuesCount()).toBe(0);
  });

  it("should clear all dynamic values", () => {
    addSensitiveValues(["long-secret-value-one-12345", "long-secret-value-two-67890"]);
    expect(getDynamicSensitiveValuesCount()).toBe(2);

    clearDynamicSensitiveValues();
    expect(getDynamicSensitiveValuesCount()).toBe(0);
  });

  it("should handle text without sensitive data", () => {
    const text = "This is a normal message without secrets";
    const redacted = redactSensitiveText(text);
    expect(redacted).toBe(text);
  });
});
