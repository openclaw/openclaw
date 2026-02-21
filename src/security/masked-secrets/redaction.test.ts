import { describe, expect, it } from "vitest";
import { redactOutput } from "./redaction.js";
import { SecretStore } from "./secret-store.js";

describe("redactOutput", () => {
  function makeStore(secrets: Record<string, string>): SecretStore {
    const store = new SecretStore({ mask: Object.keys(secrets) });
    for (const [key, value] of Object.entries(secrets)) {
      process.env[key] = value;
    }
    store.load();
    for (const key of Object.keys(secrets)) {
      delete process.env[key];
    }
    return store;
  }

  describe("exact value redaction", () => {
    it("redacts known secret values from output", () => {
      const store = makeStore({
        API_KEY: "sk-very-secret-key-12345678",
      });
      const result = redactOutput(
        'Response: {"key": "sk-very-secret-key-12345678", "status": "ok"}',
        store,
      );

      expect(result.text).toBe('Response: {"key": "[REDACTED]", "status": "ok"}');
      expect(result.count).toBeGreaterThan(0);
      expect(result.redactedSecrets).toContain("API_KEY");
    });

    it("redacts multiple occurrences of the same secret", () => {
      const store = makeStore({
        TOKEN: "my-secret-token-value-1234",
      });
      const result = redactOutput(
        "token=my-secret-token-value-1234 also my-secret-token-value-1234",
        store,
      );

      expect(result.text).toBe("token=[REDACTED] also [REDACTED]");
      expect(result.count).toBe(2);
    });

    it("redacts longest values first to avoid partial matches", () => {
      const store = makeStore({
        SHORT: "secret-12345678",
        LONG: "secret-1234567890abcdef",
      });
      const result = redactOutput("the value is secret-1234567890abcdef here", store);

      expect(result.text).toBe("the value is [REDACTED] here");
    });

    it("does not redact very short values (< 8 chars)", () => {
      const store = makeStore({ SHORT: "abc" });
      const result = redactOutput("abc is in the output", store);

      // Short values are excluded by getValues()
      expect(result.text).toBe("abc is in the output");
    });
  });

  describe("pattern-based redaction", () => {
    it("redacts Anthropic API keys", () => {
      const store = makeStore({});
      const result = redactOutput("key: sk-ant-api03-abcdefghijklmnopqrstuvwxyz", store);

      expect(result.text).toContain("[REDACTED]");
      expect(result.text).not.toContain("sk-ant-");
    });

    it("redacts GitHub tokens", () => {
      const store = makeStore({});
      const result = redactOutput("token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij", store);

      expect(result.text).toContain("[REDACTED]");
      expect(result.text).not.toContain("ghp_");
    });

    it("redacts AWS access keys", () => {
      const store = makeStore({});
      const result = redactOutput("aws_key: AKIAIOSFODNN7EXAMPLE", store);

      expect(result.text).toContain("[REDACTED]");
      expect(result.text).not.toContain("AKIA");
    });

    it("does not redact normal text", () => {
      const store = makeStore({});
      const result = redactOutput("Hello, this is normal output with no secrets", store);

      expect(result.text).toBe("Hello, this is normal output with no secrets");
      expect(result.count).toBe(0);
    });
  });
});
