import { describe, expect, it } from "vitest";
import { PrivacyDetector } from "./detector.js";

describe("PrivacyDetector", () => {
  const detector = new PrivacyDetector("extended");

  describe("email detection", () => {
    it("detects email addresses", () => {
      const result = detector.detect("Contact me at user@gmail.com for details");
      expect(result.hasPrivacyRisk).toBe(true);
      expect(result.matches).toHaveLength(1);
      expect(result.matches[0].type).toBe("email");
      expect(result.matches[0].content).toBe("user@gmail.com");
    });

    it("detects multiple emails", () => {
      const result = detector.detect("Send to alice@test.com and bob@example.org");
      expect(result.matches.filter((m) => m.type === "email")).toHaveLength(2);
    });
  });

  describe("phone detection", () => {
    it("detects China mainland phone numbers", () => {
      const result = detector.detect("My phone is 13812345678");
      expect(result.hasPrivacyRisk).toBe(true);
      const phoneMatches = result.matches.filter((m) => m.type === "phone_cn");
      expect(phoneMatches).toHaveLength(1);
      expect(phoneMatches[0].content).toBe("13812345678");
    });
  });

  describe("ID card detection", () => {
    it("detects China ID card numbers", () => {
      const result = detector.detect("ID: 110101199001011234");
      expect(result.hasPrivacyRisk).toBe(true);
      const idMatches = result.matches.filter((m) => m.type === "id_card_cn");
      expect(idMatches.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("API key detection", () => {
    it("detects OpenAI API keys", () => {
      const result = detector.detect("Use key: sk-proj1234567890abcdefghijklm");
      expect(result.hasPrivacyRisk).toBe(true);
      const apiMatches = result.matches.filter((m) => m.type === "openai_api_key");
      expect(apiMatches.length).toBeGreaterThanOrEqual(1);
    });

    it("detects GitHub tokens", () => {
      const result = detector.detect("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij");
      expect(result.hasPrivacyRisk).toBe(true);
      const ghMatches = result.matches.filter((m) => m.type === "github_token");
      expect(ghMatches.length).toBeGreaterThanOrEqual(1);
    });

    it("detects Anthropic API keys", () => {
      const result = detector.detect("sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890");
      expect(result.hasPrivacyRisk).toBe(true);
    });

    it("detects AWS access keys", () => {
      const result = detector.detect("AKIAIOSFODNN7EXAMPLE");
      expect(result.hasPrivacyRisk).toBe(true);
      expect(result.matches.some((m) => m.type === "aws_access_key")).toBe(true);
    });
  });

  describe("password detection", () => {
    it("detects password assignments", () => {
      const result = detector.detect("password=MyS3cretPass123");
      expect(result.hasPrivacyRisk).toBe(true);
      const pwdMatches = result.matches.filter(
        (m) => m.type === "password_assignment" || m.type === "env_password",
      );
      expect(pwdMatches.length).toBeGreaterThanOrEqual(1);
    });

    it("detects environment variable passwords", () => {
      const result = detector.detect("PASSWORD=super_secret_value");
      expect(result.hasPrivacyRisk).toBe(true);
    });
  });

  describe("credit card detection", () => {
    it("detects Visa card numbers", () => {
      const result = detector.detect("Card: 4111111111111111");
      expect(result.hasPrivacyRisk).toBe(true);
      expect(result.matches.some((m) => m.type === "credit_card")).toBe(true);
    });
  });

  describe("JWT detection", () => {
    it("detects JWT tokens", () => {
      const jwt =
        "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
      const result = detector.detect(jwt);
      expect(result.hasPrivacyRisk).toBe(true);
      expect(result.matches.some((m) => m.type === "jwt_token")).toBe(true);
    });
  });

  describe("database URL detection", () => {
    it("detects MySQL connection strings", () => {
      const result = detector.detect("mysql://root:password123@localhost/mydb");
      expect(result.hasPrivacyRisk).toBe(true);
      expect(result.matches.some((m) => m.type === "database_url_mysql")).toBe(true);
    });

    it("detects PostgreSQL connection strings", () => {
      const result = detector.detect("postgresql://user:pass@db.example.com/prod");
      expect(result.hasPrivacyRisk).toBe(true);
    });
  });

  describe("SSH key detection", () => {
    it("detects full SSH private key blocks", () => {
      const result = detector.detect(
        "-----BEGIN RSA PRIVATE KEY-----\nABCDEF1234567890\n-----END RSA PRIVATE KEY-----",
      );
      expect(result.hasPrivacyRisk).toBe(true);
      expect(result.matches.some((m) => m.type === "ssh_private_key")).toBe(true);
    });
  });

  describe("context-based rules", () => {
    it("requires context for bank account numbers", () => {
      // Without context keywords — should not match bank_account_cn.
      const result1 = detector.detect("Number is 6222021234567890123");
      const bankMatches1 = result1.matches.filter((m) => m.type === "bank_account_cn");
      expect(bankMatches1).toHaveLength(0);

      // With context keywords — should match.
      const result2 = detector.detect("银行卡号 6222021234567890123");
      const bankMatches2 = result2.matches.filter((m) => m.type === "bank_account_cn");
      expect(bankMatches2.length).toBeGreaterThanOrEqual(1);
    });

    it("does not throw when context fields are malformed", () => {
      const malformedContextRules = [
        {
          type: "ctx_malformed",
          description: "Malformed context rule",
          enabled: true,
          riskLevel: "medium",
          pattern: "password",
          context: { mustContain: "password", mustNotContain: { nope: true } },
        },
      ] as unknown as ConstructorParameters<typeof PrivacyDetector>[0];

      const customDetector = new PrivacyDetector(malformedContextRules);
      expect(() => customDetector.detect("password=secret")).not.toThrow();
    });
  });

  describe("pattern + keywords combination", () => {
    it("matches keyword entries even when rule also defines pattern", () => {
      const customDetector = new PrivacyDetector([
        {
          type: "combo_rule",
          description: "Pattern + keyword combo",
          enabled: true,
          riskLevel: "high",
          pattern: "SECRET_[0-9]+",
          keywords: ["fallback-secret"],
        },
      ]);

      const keywordOnly = customDetector.detect("contains fallback-secret only");
      expect(keywordOnly.matches.some((m) => m.type === "combo_rule")).toBe(true);

      const patternOnly = customDetector.detect("contains SECRET_123 only");
      expect(patternOnly.matches.some((m) => m.type === "combo_rule")).toBe(true);
    });
  });

  describe("risk levels", () => {
    it("reports correct highest risk level", () => {
      const result = detector.detect("password=secret123 email: test@test.com");
      expect(result.highestRiskLevel).toBe("critical");
    });
  });

  describe("bare password detection", () => {
    it("detects complex passwords (3+ char classes)", () => {
      const cases = ["MyS3cret!Pass", "Admin@2024!", "P@ssw0rd!123", "a1B2c3D4e5!@", "Tr0ub4dor&3"];
      for (const text of cases) {
        const result = detector.detect(text);
        expect(
          result.matches.some((m) => m.type === "bare_password"),
          `should detect: ${text}`,
        ).toBe(true);
      }
    });

    it("does not detect low-complexity strings as passwords", () => {
      const cases = ["qwerty12345", "helloworld", "12345678", "Ab1!"];
      for (const text of cases) {
        const result = detector.detect(text);
        expect(
          result.matches.some((m) => m.type === "bare_password"),
          `should NOT detect: ${text}`,
        ).toBe(false);
      }
    });

    it("does not detect URLs or identifiers as passwords", () => {
      const result1 = detector.detect("https://example.com");
      expect(result1.matches.some((m) => m.type === "bare_password")).toBe(false);

      const result2 = detector.detect("my-variable-name");
      expect(result2.matches.some((m) => m.type === "bare_password")).toBe(false);
    });
  });

  describe("high entropy string detection", () => {
    it("detects random alphanumeric strings", () => {
      const result = detector.detect("A9f_2KxP0mQ7vT3nL8yR1wC6uH5zJ4d");
      expect(result.matches.some((m) => m.type === "high_entropy_string")).toBe(true);
    });

    it("rejects sequential strings", () => {
      const result = detector.detect("abcdefghijklmnop");
      expect(result.matches.some((m) => m.type === "high_entropy_string")).toBe(false);
    });

    it("rejects repeated characters", () => {
      const result = detector.detect("aaaaaaaaaaaaaaaa");
      expect(result.matches.some((m) => m.type === "high_entropy_string")).toBe(false);
    });

    it("does not flag git commit SHAs as high entropy secrets", () => {
      const result = detector.detect("ece2dab06df56b4f3771f3b28e863c216a4afae0");
      expect(result.matches.some((m) => m.type === "high_entropy_string")).toBe(false);
    });
  });

  describe("edge cases", () => {
    it("handles empty text", () => {
      const result = detector.detect("");
      expect(result.hasPrivacyRisk).toBe(false);
      expect(result.matches).toHaveLength(0);
    });

    it("handles text without sensitive content", () => {
      const result = detector.detect("Hello, this is a normal message.");
      expect(result.hasPrivacyRisk).toBe(false);
    });

    it("deduplicates overlapping matches", () => {
      const result = detector.detect("sk-proj1234567890abcdefghijklm");
      const types = result.matches.map((m) => `${m.start}:${m.end}:${m.type}`);
      const unique = new Set(types);
      expect(types.length).toBe(unique.size);
    });
  });
});
