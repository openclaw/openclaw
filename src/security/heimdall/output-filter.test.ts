import { describe, expect, it } from "vitest";
import { redactOutput, BUILTIN_PATTERNS } from "./output-filter.js";

describe("redactOutput", () => {
  // -------------------------------------------------------------------------
  // Built-in pattern: OpenAI API Key
  // -------------------------------------------------------------------------

  it("redacts OpenAI API keys (sk-proj-...)", () => {
    const input = "Use key sk-proj-abc12345678901234567890 to authenticate.";
    const result = redactOutput(input);
    expect(result.redacted).toBe("Use key [REDACTED:OpenAI API Key] to authenticate.");
    expect(result.matches).toEqual([{ pattern: "OpenAI API Key", count: 1 }]);
  });

  it("does NOT redact normal words containing 'sk-' (e.g. 'risk-averse')", () => {
    const input = "The risk-averse approach avoids brisk-action in task-management.";
    const result = redactOutput(input);
    expect(result.redacted).toBe(input);
    expect(result.matches).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Built-in pattern: GitHub PAT (ghp_)
  // -------------------------------------------------------------------------

  it("redacts GitHub PAT tokens (ghp_ + 36 chars)", () => {
    const token = "ghp_" + "a".repeat(36);
    const input = `git clone https://x:${token}@github.com/repo.git`;
    const result = redactOutput(input);
    expect(result.redacted).toBe("git clone https://x:[REDACTED:GitHub PAT]@github.com/repo.git");
    expect(result.matches).toEqual([{ pattern: "GitHub PAT", count: 1 }]);
  });

  // -------------------------------------------------------------------------
  // Built-in pattern: GitHub OAuth (gho_)
  // -------------------------------------------------------------------------

  it("redacts GitHub OAuth tokens (gho_ + 36 chars)", () => {
    const token = "gho_" + "B".repeat(40);
    const input = `token: ${token}`;
    const result = redactOutput(input);
    expect(result.redacted).toBe("token: [REDACTED:GitHub OAuth]");
    expect(result.matches).toEqual([{ pattern: "GitHub OAuth", count: 1 }]);
  });

  // -------------------------------------------------------------------------
  // Built-in pattern: GitHub App (ghs_)
  // -------------------------------------------------------------------------

  it("redacts GitHub App tokens (ghs_ + 36 chars)", () => {
    const token = "ghs_" + "c".repeat(36);
    const input = `GITHUB_TOKEN=${token}`;
    const result = redactOutput(input);
    expect(result.redacted).toBe("GITHUB_TOKEN=[REDACTED:GitHub App]");
    expect(result.matches).toEqual([{ pattern: "GitHub App", count: 1 }]);
  });

  // -------------------------------------------------------------------------
  // Built-in pattern: Bearer Token
  // -------------------------------------------------------------------------

  it("redacts Bearer tokens (Bearer eyJhbGci...)", () => {
    const jwt = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature";
    const input = `Authorization: Bearer ${jwt}`;
    const result = redactOutput(input);
    expect(result.redacted).toBe("Authorization: [REDACTED:Bearer Token]");
    expect(result.matches).toEqual([{ pattern: "Bearer Token", count: 1 }]);
  });

  // -------------------------------------------------------------------------
  // Built-in pattern: AWS Access Key
  // -------------------------------------------------------------------------

  it("redacts AWS Access Key IDs (AKIA...)", () => {
    const input = "aws_access_key_id = AKIAIOSFODNN7EXAMPLE";
    const result = redactOutput(input);
    expect(result.redacted).toBe("aws_access_key_id = [REDACTED:AWS Access Key]");
    expect(result.matches).toEqual([{ pattern: "AWS Access Key", count: 1 }]);
  });

  // -------------------------------------------------------------------------
  // Multi-line / multiple secrets
  // -------------------------------------------------------------------------

  it("handles multiline content with multiple different secrets", () => {
    const openaiKey = "sk-proj-abcdefghij1234567890X";
    const ghToken = "ghp_" + "x".repeat(40);
    const awsKey = "AKIAIOSFODNN7EXAMPLE";

    const input = [
      `OPENAI_API_KEY=${openaiKey}`,
      `GITHUB_TOKEN=${ghToken}`,
      `AWS_KEY=${awsKey}`,
    ].join("\n");

    const result = redactOutput(input);

    expect(result.redacted).toBe(
      [
        "OPENAI_API_KEY=[REDACTED:OpenAI API Key]",
        "GITHUB_TOKEN=[REDACTED:GitHub PAT]",
        "AWS_KEY=[REDACTED:AWS Access Key]",
      ].join("\n"),
    );

    expect(result.matches).toEqual([
      { pattern: "OpenAI API Key", count: 1 },
      { pattern: "GitHub PAT", count: 1 },
      { pattern: "AWS Access Key", count: 1 },
    ]);
  });

  it("counts multiple occurrences of the same pattern", () => {
    const key1 = "AKIAIOSFODNN7EXAMPLE";
    const key2 = "AKIAIOSFODNN7XXXXXXX";
    const input = `key1=${key1} key2=${key2}`;
    const result = redactOutput(input);

    expect(result.redacted).toBe("key1=[REDACTED:AWS Access Key] key2=[REDACTED:AWS Access Key]");
    expect(result.matches).toEqual([{ pattern: "AWS Access Key", count: 2 }]);
  });

  // -------------------------------------------------------------------------
  // Custom patterns
  // -------------------------------------------------------------------------

  it("applies custom patterns alongside built-in ones", () => {
    const input = "DB password: hunter2, key: AKIAIOSFODNN7EXAMPLE";
    const result = redactOutput(input, {
      customPatterns: [{ name: "DB Password", regex: "hunter2", flags: "g" }],
    });

    expect(result.redacted).toBe(
      "DB password: [REDACTED:DB Password], key: [REDACTED:AWS Access Key]",
    );
    expect(result.matches).toContainEqual({ pattern: "DB Password", count: 1 });
    expect(result.matches).toContainEqual({ pattern: "AWS Access Key", count: 1 });
  });

  it("supports custom pattern with custom flags", () => {
    const input = "Secret-Value and secret-value both match";
    const result = redactOutput(input, {
      customPatterns: [{ name: "Custom Secret", regex: "secret-value", flags: "gi" }],
    });

    expect(result.redacted).toBe(
      "[REDACTED:Custom Secret] and [REDACTED:Custom Secret] both match",
    );
    expect(result.matches).toContainEqual({ pattern: "Custom Secret", count: 2 });
  });

  // -------------------------------------------------------------------------
  // Disabled filter
  // -------------------------------------------------------------------------

  it("returns input unchanged when config.enabled is false", () => {
    const input = "sk-proj-abc12345678901234567890 AKIAIOSFODNN7EXAMPLE";
    const result = redactOutput(input, { enabled: false });

    expect(result.redacted).toBe(input);
    expect(result.matches).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  it("returns empty string with no matches for empty input", () => {
    const result = redactOutput("");
    expect(result.redacted).toBe("");
    expect(result.matches).toEqual([]);
  });

  it("returns input unchanged when no patterns match", () => {
    const input = "This is perfectly safe text with no secrets.";
    const result = redactOutput(input);
    expect(result.redacted).toBe(input);
    expect(result.matches).toEqual([]);
  });

  it("returns proper RedactionResult shape", () => {
    const result = redactOutput("nothing sensitive");
    expect(result).toHaveProperty("redacted");
    expect(result).toHaveProperty("matches");
    expect(Array.isArray(result.matches)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Edge cases: custom pattern resilience
  // -------------------------------------------------------------------------

  it("works with explicit enabled=true config", () => {
    const input = "key: AKIAIOSFODNN7EXAMPLE";
    const result = redactOutput(input, { enabled: true });
    expect(result.redacted).toBe("key: [REDACTED:AWS Access Key]");
  });

  it("applies default 'g' flag when custom pattern omits flags", () => {
    const input = "secret123 and secret456";
    const result = redactOutput(input, {
      customPatterns: [{ name: "Custom", regex: "secret\\d+" }],
    });
    expect(result.redacted).toBe("[REDACTED:Custom] and [REDACTED:Custom]");
    expect(result.matches).toContainEqual({ pattern: "Custom", count: 2 });
  });

  it("skips invalid custom regex without crashing", () => {
    const input = "normal text with AKIAIOSFODNN7EXAMPLE key";
    const result = redactOutput(input, {
      customPatterns: [{ name: "Bad Pattern", regex: "[invalid((" }],
    });
    // Invalid pattern is silently skipped; built-in still works
    expect(result.redacted).toBe("normal text with [REDACTED:AWS Access Key] key");
    expect(result.matches).toEqual([{ pattern: "AWS Access Key", count: 1 }]);
  });

  it("redacts secrets at string boundaries (start and end)", () => {
    const awsKey = "AKIAIOSFODNN7EXAMPLE";
    const result = redactOutput(awsKey);
    expect(result.redacted).toBe("[REDACTED:AWS Access Key]");
  });

  // -------------------------------------------------------------------------
  // BUILTIN_PATTERNS export
  // -------------------------------------------------------------------------

  it("exports BUILTIN_PATTERNS with expected entries", () => {
    const names = BUILTIN_PATTERNS.map((p) => p.name);
    expect(names).toContain("OpenAI API Key");
    expect(names).toContain("GitHub PAT");
    expect(names).toContain("GitHub OAuth");
    expect(names).toContain("GitHub App");
    expect(names).toContain("Bearer Token");
    expect(names).toContain("AWS Access Key");
  });
});
