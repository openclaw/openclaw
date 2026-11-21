// Tests for observer-evidence: evidence construction, redaction, and validation.
import { describe, expect, it } from "vitest";
import { EvidenceRecordSchema } from "../config/zod-schema.registry-validation.js";
import {
  computeValueHash,
  createEvidenceRecord,
  createEvidenceRecordAt,
  isEvidenceRecordLike,
  isSensitiveEnvKey,
  redactSensitiveFields,
  redactSensitiveString,
  redactSensitiveUrl,
} from "./observer-evidence.js";

const FIXED_TIME = "2026-07-18T12:00:00.000Z";

describe("observer-evidence", () => {
  describe("createEvidenceRecord", () => {
    it("constructs a valid EvidenceRecord", () => {
      const record = createEvidenceRecord(
        {
          evidenceType: "CONFIG",
          source: "test-source",
          collector: "test-collector",
          confidence: "HIGH",
          value: "test-value",
          notes: "test notes",
        },
        FIXED_TIME,
      );
      expect(record.evidenceType).toBe("CONFIG");
      expect(record.source).toBe("test-source");
      expect(record.collectedAt).toBe(FIXED_TIME);
      expect(record.collector).toBe("test-collector");
      expect(record.confidence).toBe("HIGH");
      expect(record.valueHash).toBeTruthy();
      expect(record.notes).toBe("test notes");
    });

    it("computes correct SHA-256 value hash", () => {
      const record = createEvidenceRecord(
        {
          evidenceType: "PROCESS",
          source: "test",
          collector: "test",
          confidence: "HIGH",
          value: "hello",
        },
        FIXED_TIME,
      );
      // SHA-256 of "hello" = 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
      expect(record.valueHash).toBe(
        "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      );
    });

    it("returns null valueHash for null value", () => {
      const record = createEvidenceRecord(
        {
          evidenceType: "CONFIG",
          source: "test",
          collector: "test",
          confidence: "LOW",
          value: null,
        },
        FIXED_TIME,
      );
      expect(record.valueHash).toBeNull();
    });

    it("returns null valueHash for empty string", () => {
      const record = createEvidenceRecord(
        {
          evidenceType: "CONFIG",
          source: "test",
          collector: "test",
          confidence: "LOW",
          value: "",
        },
        FIXED_TIME,
      );
      expect(record.valueHash).toBeNull();
    });

    it("produces evidence that validates against Phase 4F1 schema", () => {
      const record = createEvidenceRecord(
        {
          evidenceType: "FILESYSTEM",
          source: "fs-observer",
          collector: "FilesystemObserver",
          confidence: "HIGH",
          value: "/some/path",
          notes: "File exists",
        },
        FIXED_TIME,
      );
      const result = EvidenceRecordSchema.safeParse(record);
      expect(result.success).toBe(true);
    });

    it("redacts sensitive content in notes", () => {
      const record = createEvidenceRecord(
        {
          evidenceType: "HTTP",
          source: "service-probe",
          collector: "ServiceObserver",
          confidence: "HIGH",
          value: null,
          notes: "Authorization: Bearer super-secret-token-12345",
        },
        FIXED_TIME,
      );
      expect(record.notes).not.toContain("super-secret-token-12345");
      expect(record.notes).toContain("***REDACTED***");
    });

    it("createEvidenceRecordAt is an alias for createEvidenceRecord", () => {
      const r1 = createEvidenceRecord(
        { evidenceType: "CONFIG", source: "s", collector: "c", confidence: "HIGH", value: "v" },
        FIXED_TIME,
      );
      const r2 = createEvidenceRecordAt(
        { evidenceType: "CONFIG", source: "s", collector: "c", confidence: "HIGH", value: "v" },
        FIXED_TIME,
      );
      expect(r1).toEqual(r2);
    });
  });

  describe("computeValueHash", () => {
    it("returns null for null", () => {
      expect(computeValueHash(null)).toBeNull();
    });
    it("returns null for undefined", () => {
      expect(computeValueHash(undefined)).toBeNull();
    });
    it("returns null for empty string", () => {
      expect(computeValueHash("")).toBeNull();
    });
    it("returns SHA-256 hex for non-empty string", () => {
      const hash = computeValueHash("test");
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe("isEvidenceRecordLike", () => {
    it("returns true for valid EvidenceRecord", () => {
      const record = createEvidenceRecord(
        { evidenceType: "CONFIG", source: "s", collector: "c", confidence: "HIGH", value: "v" },
        FIXED_TIME,
      );
      expect(isEvidenceRecordLike(record)).toBe(true);
    });
    it("returns false for null", () => {
      expect(isEvidenceRecordLike(null)).toBe(false);
    });
    it("returns false for non-object", () => {
      expect(isEvidenceRecordLike("string")).toBe(false);
    });
    it("returns false for object missing required fields", () => {
      expect(isEvidenceRecordLike({ evidenceType: "CONFIG" })).toBe(false);
    });
    it("returns false for invalid confidence", () => {
      expect(
        isEvidenceRecordLike({
          evidenceType: "CONFIG",
          source: "s",
          collectedAt: FIXED_TIME,
          collector: "c",
          confidence: "ULTRA",
          valueHash: null,
          notes: null,
        }),
      ).toBe(false);
    });
  });

  describe("redactSensitiveFields", () => {
    it("redacts token field", () => {
      const result = redactSensitiveFields({ token: "secret-value", name: "safe" });
      expect(result.token).toBe("***REDACTED***");
      expect(result.name).toBe("safe");
    });
    it("redacts password field", () => {
      const result = redactSensitiveFields({ password: "secret", apiKey: "key123" });
      expect(result.password).toBe("***REDACTED***");
      expect(result.apiKey).toBe("***REDACTED***");
    });
    it("redacts nested objects", () => {
      const result = redactSensitiveFields({ config: { secret: "value", safe: "ok" } });
      expect(result.config).toEqual({ secret: "***REDACTED***", safe: "ok" });
    });
  });

  describe("redactSensitiveFields arrays", () => {
    it("redacts a flat array containing a secret-bearing string", () => {
      const input = { items: ["Authorization: Bearer top-secret", "safe"] };
      const result = redactSensitiveFields(input);

      expect(result.items).toEqual(["Authorization: ***REDACTED***", "safe"]);
    });

    it("redacts an array containing an object with a sensitive field", () => {
      const input = { items: [{ apiKey: "key-123", safe: true }] };
      const result = redactSensitiveFields(input);

      expect(result.items).toEqual([{ apiKey: "***REDACTED***", safe: true }]);
    });

    it("redacts nested arrays containing sensitive strings", () => {
      const input = { items: [["X-Auth-Token: token-123"], ["safe"]] };
      const result = redactSensitiveFields(input);

      expect(result.items).toEqual([["X-Auth-Token: ***"], ["safe"]]);
    });

    it("redacts a mixed array and preserves length and ordering", () => {
      const input = {
        items: [
          "first",
          7,
          true,
          null,
          { password: "secret" },
          ["Authorization: Basic user:pass"],
          "last",
        ],
      };
      const snapshot = structuredClone(input);
      const result = redactSensitiveFields(input);

      expect(result.items).toHaveLength(7);
      expect(result.items).toEqual([
        "first",
        7,
        true,
        null,
        { password: "***REDACTED***" },
        ["Authorization: ***REDACTED***"],
        "last",
      ]);
      expect(input).toEqual(snapshot);
    });

    it("preserves original nested objects and arrays unchanged", () => {
      const nested = { secret: "value", inner: [{ token: "abc" }] };
      const input = { items: [nested, [nested]] };
      const snapshot = structuredClone(input);

      redactSensitiveFields(input);

      expect(input).toEqual(snapshot);
      expect(input.items[0]).toBe(nested);
      expect(input.items[1][0]).toBe(nested);
    });

    it("redacts Authorization Bearer inside an array", () => {
      const result = redactSensitiveFields({ items: ["Authorization: Bearer secret-token"] });
      expect(result.items).toEqual(["Authorization: ***REDACTED***"]);
    });

    it("redacts Authorization Basic inside an array", () => {
      const result = redactSensitiveFields({
        items: ["Authorization: Basic dXNlcjpwYXNzd29yZA=="],
      });
      expect(result.items).toEqual(["Authorization: ***REDACTED***"]);
    });

    it("redacts X-API-Key inside an array", () => {
      const result = redactSensitiveFields({ items: ["X-API-Key: secret-token-12345"] });
      expect(result.items).toEqual(["X-API-Key: ***"]);
    });

    it("redacts X-Auth-Token inside an array", () => {
      const result = redactSensitiveFields({ items: ["X-Auth-Token: secret-token-12345"] });
      expect(result.items).toEqual(["X-Auth-Token: ***"]);
    });

    it("redacts multiple secret-bearing values in one array", () => {
      const result = redactSensitiveFields({
        items: [
          "Authorization: Bearer alpha",
          "X-API-Key=beta",
          "X-Auth-Token: gamma",
          { password: "delta" },
        ],
      });

      expect(result.items).toEqual([
        "Authorization: ***REDACTED***",
        "X-API-Key: ***",
        "X-Auth-Token: ***",
        { password: "***REDACTED***" },
      ]);
    });

    it("leaves unrelated array content unchanged", () => {
      const result = redactSensitiveFields({
        items: ["alpha", 3, false, null, { safe: "ok" }, [1, 2]],
      });
      expect(result.items).toEqual(["alpha", 3, false, null, { safe: "ok" }, [1, 2]]);
    });
  });

  describe("redactSensitiveString", () => {
    it("redacts Bearer tokens", () => {
      const result = redactSensitiveString("Authorization: Bearer my-secret-token-12345");
      expect(result).not.toContain("my-secret-token-12345");
      expect(result).toContain("***REDACTED***");
    });
    it("redacts credentials in URLs", () => {
      const result = redactSensitiveString("https://user:pass@host.com/path");
      expect(result).not.toContain("user:pass");
      expect(result).toContain("***:***");
    });
  });

  describe("redactSensitiveUrl", () => {
    it("redacts user:pass in URL", () => {
      const result = redactSensitiveUrl("https://user:pass@host.com/path");
      expect(result).not.toContain("user:pass");
      expect(result).toContain("***:***");
    });
    it("redacts token query param", () => {
      const result = redactSensitiveUrl("https://host.com/path?token=secret123");
      expect(result).not.toContain("secret123");
      expect(result).toContain("***");
    });
    it("does not modify URLs without credentials", () => {
      const url = "https://host.com/path?safe=value";
      expect(redactSensitiveUrl(url)).toBe(url);
    });
    it("returns original for non-URL strings", () => {
      const value = "not-a-url";
      expect(redactSensitiveUrl(value)).toBe(value);
    });
  });

  describe("isSensitiveEnvKey", () => {
    it("returns true for TOKEN", () => {
      expect(isSensitiveEnvKey("OPENCLAW_TOKEN")).toBe(true);
    });
    it("returns true for API_KEY", () => {
      expect(isSensitiveEnvKey("API_KEY")).toBe(true);
    });
    it("returns true for PASSWORD", () => {
      expect(isSensitiveEnvKey("PASSWORD")).toBe(true);
    });
    it("returns true for AUTHORIZATION", () => {
      expect(isSensitiveEnvKey("AUTHORIZATION")).toBe(true);
    });
    it("returns false for safe keys", () => {
      expect(isSensitiveEnvKey("HOME")).toBe(false);
      expect(isSensitiveEnvKey("PATH")).toBe(false);
    });
  });
});

// PHASE_4F2_AUTHORIZATION_REDACTION_REGRESSION_TESTS
describe("redactSensitiveString authorization-style header regression", () => {
  it("redacts a complete Bearer authorization value", () => {
    const input = "Authorization: Bearer real-secret";
    const output = redactSensitiveString(input);

    expect(output).toBe("Authorization: ***REDACTED***");
    expect(output).not.toContain("Bearer");
    expect(output).not.toContain("real-secret");
  });

  it("redacts a complete Basic authorization value", () => {
    const input = "Authorization: Basic dXNlcjpwYXNzd29yZA==";
    const output = redactSensitiveString(input);

    expect(output).toBe("Authorization: ***REDACTED***");
    expect(output).not.toContain("Basic");
    expect(output).not.toContain("dXNlcjpwYXNzd29yZA==");
  });

  it("redacts an API key using a colon separator", () => {
    const input = "X-API-Key: secret-token-12345";
    const output = redactSensitiveString(input);

    expect(output).toBe("X-API-Key: ***REDACTED***");
    expect(output).not.toContain("secret-token-12345");
  });

  it("redacts an API key using an equals separator", () => {
    const input = "X-API-Key=secret-token-12345";
    const output = redactSensitiveString(input);

    expect(output).toBe("X-API-Key: ***REDACTED***");
    expect(output).not.toContain("secret-token-12345");
  });

  it("redacts an X-Auth-Token value", () => {
    const input = "X-Auth-Token: secret-token-12345";
    const output = redactSensitiveString(input);

    expect(output).toBe("X-Auth-Token: ***REDACTED***");
    expect(output).not.toContain("secret-token-12345");
  });

  it("matches authorization header names case-insensitively", () => {
    const input = "authorization: Bearer lower-case-secret";
    const output = redactSensitiveString(input);

    expect(output.toLowerCase()).toContain("authorization: ***redacted***");
    expect(output).not.toContain("lower-case-secret");
  });

  it("redacts multiple sensitive headers on separate lines", () => {
    const input = [
      "Authorization: Bearer first-secret",
      "X-API-Key=second-secret",
      "X-Auth-Token: third-secret",
    ].join("\n");

    const output = redactSensitiveString(input);

    expect(output).toContain("Authorization: ***REDACTED***");
    expect(output).toContain("X-API-Key: ***REDACTED***");
    expect(output).toContain("X-Auth-Token: ***REDACTED***");
    expect(output).not.toContain("first-secret");
    expect(output).not.toContain("second-secret");
    expect(output).not.toContain("third-secret");
  });

  it("preserves following non-sensitive lines", () => {
    const input = ["Authorization: Bearer real-secret", "Content-Type: application/json"].join(
      "\n",
    );

    const output = redactSensitiveString(input);

    expect(output).toBe(
      ["Authorization: ***REDACTED***", "Content-Type: application/json"].join("\n"),
    );
  });

  it("preserves unrelated surrounding text", () => {
    const input = ["Request failed", "Authorization: Bearer real-secret", "Retry disabled"].join(
      "\n",
    );

    const output = redactSensitiveString(input);

    expect(output).toContain("Request failed");
    expect(output).toContain("Retry disabled");
    expect(output).not.toContain("real-secret");
  });

  it("does not produce a malformed replacement", () => {
    const output = redactSensitiveString("Authorization: Bearer real-secret");

    expect(output).not.toContain("$1");
    expect(output).not.toMatch(/^\s*:\s*\*\*\*REDACTED\*\*\*/);
  });
});
