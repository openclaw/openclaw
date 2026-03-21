import { describe, expect, it } from "vitest";
import {
  buildCredentialIndex,
  isSecretSanitizationEnabled,
  sanitizeSecrets,
} from "./sanitize-secrets.js";
import type { OpenClawConfig } from "../../config/config.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const emptyIndex = new Map<string, string>();

function makeConfig(messages?: Record<string, unknown>): OpenClawConfig {
  return { messages } as unknown as OpenClawConfig;
}

// ---------------------------------------------------------------------------
// Known prefix detection
// ---------------------------------------------------------------------------

describe("sanitizeSecrets — known prefixes", () => {
  it("redacts GitHub PAT (ghp_)", () => {
    const result = sanitizeSecrets("token is ghp_abc123XYZ456789abcdef", emptyIndex);
    expect(result.redacted).toBe(true);
    expect(result.text).not.toContain("ghp_abc123XYZ456789abcdef");
    expect(result.text).toContain("key(ghp");
  });

  it("redacts Anthropic key (sk-ant-)", () => {
    const result = sanitizeSecrets("key=sk-ant-api03-longsecretkeyvalue123456789", emptyIndex);
    expect(result.redacted).toBe(true);
    expect(result.text).not.toContain("sk-ant-");
  });

  it("redacts OpenAI project key (sk-proj-)", () => {
    const result = sanitizeSecrets("sk-proj-abcdefghijklmnopqrstuvwxyz123456", emptyIndex);
    expect(result.redacted).toBe(true);
  });

  it("redacts Slack bot token (xoxb-)", () => {
    // Fake token — xoxb- prefix with sufficient length triggers detection
    const fakeSlackToken = ["xoxb", "FAKEFAKEFAKE", "FAKEFAKEFAKE", "FAKEFAKEFAKE"].join("-");
    const result = sanitizeSecrets(fakeSlackToken, emptyIndex);
    expect(result.redacted).toBe(true);
  });

  it("redacts AWS access key (AKIA)", () => {
    const result = sanitizeSecrets("aws key: AKIAIOSFODNN7EXAMPLE", emptyIndex);
    expect(result.redacted).toBe(true);
  });

  it("redacts Leantime API key (lt_)", () => {
    const result = sanitizeSecrets(
      "lt_kindred-agents_ed463114443aed155df0a12829196429efb51d35beca0477",
      emptyIndex,
    );
    expect(result.redacted).toBe(true);
  });

  it("does not redact short tokens below minLength", () => {
    const result = sanitizeSecrets("ghp_short", emptyIndex);
    expect(result.redacted).toBe(false);
  });

  it("preserves surrounding text", () => {
    const result = sanitizeSecrets(
      "Done. NEXTAUTH_SECRET = ghp_abc123XYZ456789abcdef stored for Rosie.",
      emptyIndex,
    );
    expect(result.text).toContain("Done.");
    expect(result.text).toContain("NEXTAUTH_SECRET");
    expect(result.text).toContain("stored for Rosie.");
    expect(result.text).not.toContain("ghp_abc123XYZ456789abcdef");
  });
});

// ---------------------------------------------------------------------------
// Named credential index
// ---------------------------------------------------------------------------

describe("sanitizeSecrets — named credentials", () => {
  it("produces key(<name>) handle for named credential", () => {
    const index = new Map([["mysupersecrettoken12345678901234", "github-pat"]]);
    const result = sanitizeSecrets("token: mysupersecrettoken12345678901234", index);
    expect(result.redacted).toBe(true);
    expect(result.text).toContain("key(github-pat)");
    expect(result.text).not.toContain("mysupersecrettoken12345678901234");
  });

  it("key() handle is more useful than opaque handle", () => {
    const index = new Map([["sk-ant-api03-longsecretkeyvalue123456789", "anthropic-main"]]);
    const result = sanitizeSecrets("sk-ant-api03-longsecretkeyvalue123456789", index);
    expect(result.text).toBe("key(anthropic-main)");
  });

  it("count reflects number of redactions", () => {
    const index = new Map([
      ["secret1_abcdefghij12345678", "cred-a"],
      ["secret2_abcdefghij12345678", "cred-b"],
    ]);
    const result = sanitizeSecrets(
      "a=secret1_abcdefghij12345678 b=secret2_abcdefghij12345678",
      index,
    );
    expect(result.count).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// High-entropy fallback
// ---------------------------------------------------------------------------

describe("sanitizeSecrets — high entropy fallback", () => {
  it("redacts high-entropy token not matching known prefixes", () => {
    // Simulate a random 32-char hex secret
    const secret = "a3f8b2c1d4e5f6a7b8c9d0e1f2a3b4c5";
    const result = sanitizeSecrets(`secret=${secret}`, emptyIndex);
    expect(result.redacted).toBe(true);
    expect(result.text).toContain("[REDACTED:high-entropy]");
  });

  it("does not redact natural language text", () => {
    const result = sanitizeSecrets("The quick brown fox jumps over the lazy dog", emptyIndex);
    expect(result.redacted).toBe(false);
    expect(result.text).toBe("The quick brown fox jumps over the lazy dog");
  });

  it("does not redact short tokens", () => {
    const result = sanitizeSecrets("abc123def456", emptyIndex);
    expect(result.redacted).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("sanitizeSecrets — edge cases", () => {
  it("handles empty string", () => {
    const result = sanitizeSecrets("", emptyIndex);
    expect(result.text).toBe("");
    expect(result.redacted).toBe(false);
    expect(result.count).toBe(0);
  });

  it("handles text with no secrets", () => {
    const result = sanitizeSecrets("Hello, the task is complete.", emptyIndex);
    expect(result.redacted).toBe(false);
    expect(result.text).toBe("Hello, the task is complete.");
  });

  it("handles multiple secrets in one message", () => {
    const result = sanitizeSecrets(
      "GitHub: ghp_abc123XYZ456789abcdef, Anthropic: sk-ant-api03-longsecretkeyvalue123456789",
      emptyIndex,
    );
    expect(result.count).toBe(2);
    expect(result.redacted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildCredentialIndex
// ---------------------------------------------------------------------------

describe("buildCredentialIndex", () => {
  it("indexes auth token values", () => {
    const cfg = {
      auth: {
        anthropic: { apiKey: "sk-ant-api03-longsecretkeyvalue123456789" },
      },
    } as unknown as OpenClawConfig;
    const index = buildCredentialIndex(cfg);
    expect(index.has("sk-ant-api03-longsecretkeyvalue123456789")).toBe(true);
    expect(index.get("sk-ant-api03-longsecretkeyvalue123456789")).toBe("anthropic:apiKey");
  });

  it("skips short values", () => {
    const cfg = {
      auth: { provider: { short: "abc" } },
    } as unknown as OpenClawConfig;
    const index = buildCredentialIndex(cfg);
    expect(index.has("abc")).toBe(false);
  });

  it("indexes channel tokens", () => {
    const cfg = {
      channels: {
        telegram: { token: "1234567890:ABCdefGHIjklMNOpqrSTUvwxYZ_longtoken" },
      },
    } as unknown as OpenClawConfig;
    const index = buildCredentialIndex(cfg);
    expect(index.has("1234567890:ABCdefGHIjklMNOpqrSTUvwxYZ_longtoken")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isSecretSanitizationEnabled
// ---------------------------------------------------------------------------

describe("isSecretSanitizationEnabled", () => {
  it("defaults to true when not configured", () => {
    expect(isSecretSanitizationEnabled(makeConfig())).toBe(true);
  });

  it("returns true when explicitly enabled", () => {
    expect(isSecretSanitizationEnabled(makeConfig({ sanitizeSecrets: true }))).toBe(true);
  });

  it("returns false when explicitly disabled", () => {
    expect(isSecretSanitizationEnabled(makeConfig({ sanitizeSecrets: false }))).toBe(false);
  });
});
