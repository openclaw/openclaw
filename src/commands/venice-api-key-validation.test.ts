import { describe, expect, it } from "vitest";
import {
  checkSuspiciousKeyFormat,
  createVeniceKeyValidator,
  validateVeniceApiKey,
} from "./venice-api-key-validation.js";

describe("checkSuspiciousKeyFormat", () => {
  it("returns undefined for any non-empty key (no format filtering)", () => {
    // Venice has multiple key types (admin, inference) - we don't filter by format
    expect(checkSuspiciousKeyFormat("abc123def456ghi789jkl012mno345")).toBeUndefined();
    expect(checkSuspiciousKeyFormat("VENICE-INFERENCE-KEY-abc123")).toBeUndefined();
    expect(checkSuspiciousKeyFormat("sk-abc123def456")).toBeUndefined();
    expect(checkSuspiciousKeyFormat("short")).toBeUndefined();
    expect(checkSuspiciousKeyFormat("any-format-works")).toBeUndefined();
  });

  it("returns error for empty keys", () => {
    expect(checkSuspiciousKeyFormat("")).toBe("API key is empty");
    expect(checkSuspiciousKeyFormat("   ")).toBe("API key is empty");
  });
});

describe("validateVeniceApiKey", () => {
  it("returns invalid for empty keys", async () => {
    const result = await validateVeniceApiKey("", { skipApiCall: true });
    expect(result.valid).toBe(false);
    expect(result.error).toBe("API key is empty");
  });

  it("returns valid for any non-empty key in test mode (no format filtering)", async () => {
    // Venice has multiple key types - we validate by API call, not format
    const keys = [
      "abc123def456ghi789jkl012mno345pqr678",
      "VENICE-INFERENCE-KEY-test",
      "sk-abc123",
      "short",
      "any-format",
    ];

    for (const key of keys) {
      const result = await validateVeniceApiKey(key, { skipApiCall: true });
      expect(result.valid).toBe(true);
    }
  });
});

describe("createVeniceKeyValidator", () => {
  it("returns error for empty input", async () => {
    const validator = createVeniceKeyValidator({ skipApiCall: true });
    const result = await validator("");
    expect(result).toBe("API key is required");
  });

  it("returns undefined for any non-empty key in test mode", async () => {
    const validator = createVeniceKeyValidator({ skipApiCall: true });

    // All formats should be accepted - validation is done via API call
    const keys = [
      "abc123def456ghi789jkl012mno345pqr678",
      "VENICE-INFERENCE-KEY-test",
      "sk-abc123",
      "any-format-works",
    ];

    for (const key of keys) {
      const result = await validator(key);
      expect(result).toBeUndefined();
    }
  });
});
