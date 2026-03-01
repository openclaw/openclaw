import { describe, expect, it } from "vitest";
import { buildSecretDetectionWarning, containsSecretPatterns } from "./detect-inbound-secrets.js";

describe("containsSecretPatterns", () => {
  it("returns false for empty input", () => {
    expect(containsSecretPatterns("")).toBe(false);
  });

  it("returns false for normal messages", () => {
    expect(containsSecretPatterns("Hello, how are you?")).toBe(false);
    expect(containsSecretPatterns("Can you help me write some code?")).toBe(false);
    expect(containsSecretPatterns("What is the weather like today?")).toBe(false);
  });

  it("detects ENV-style key assignments", () => {
    expect(containsSecretPatterns("API_KEY=abcdef1234567890")).toBe(true);
    expect(containsSecretPatterns("my SECRET_KEY=supersecretvalue")).toBe(true);
    expect(containsSecretPatterns('ACCESS_TOKEN: "mytoken123"')).toBe(true);
    expect(containsSecretPatterns("PASSWORD=hunter2")).toBe(true);
  });

  it("detects JSON-style secret fields", () => {
    expect(containsSecretPatterns('{"apiKey": "abc123def456"}')).toBe(true);
    expect(containsSecretPatterns('{"accessToken": "token_value"}')).toBe(true);
    expect(containsSecretPatterns('{"accessSecret": "secret_value"}')).toBe(true);
    expect(containsSecretPatterns('{"secretKey": "my-secret-key"}')).toBe(true);
  });

  it("detects CLI flag secrets", () => {
    expect(containsSecretPatterns("--api-key sk-abc123")).toBe(true);
    expect(containsSecretPatterns("--token my-secret-token")).toBe(true);
    expect(containsSecretPatterns("--password hunter2")).toBe(true);
  });

  it("detects Bearer tokens", () => {
    expect(containsSecretPatterns("Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5")).toBe(true);
    expect(containsSecretPatterns("Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9")).toBe(true);
  });

  it("detects PEM private keys", () => {
    expect(containsSecretPatterns("-----BEGIN RSA PRIVATE KEY-----")).toBe(true);
    expect(containsSecretPatterns("-----BEGIN PRIVATE KEY-----")).toBe(true);
  });

  it("detects well-known token prefixes", () => {
    expect(containsSecretPatterns("sk-abcdefgh12345678")).toBe(true);
    expect(containsSecretPatterns("ghp_abcdefghijklmnopqrstuv")).toBe(true);
    expect(containsSecretPatterns("github_pat_abcdefghijklmnopqrstuv")).toBe(true);
    expect(containsSecretPatterns("xoxb-123456-abcdef")).toBe(true);
    expect(containsSecretPatterns("gsk_abcdefghij")).toBe(true);
    expect(containsSecretPatterns("AIzaSyA1234567890abcdefghij")).toBe(true);
    expect(containsSecretPatterns("pplx-abcdefghij")).toBe(true);
    expect(containsSecretPatterns("npm_abcdefghij")).toBe(true);
  });

  it("detects AWS access key IDs", () => {
    expect(containsSecretPatterns("AKIAIOSFODNN7EXAMPLE")).toBe(true);
  });

  it("detects Telegram bot tokens", () => {
    expect(containsSecretPatterns("bot123456789:ABCdefGHIjklMNOpqrsTUVwxyz")).toBe(true);
    expect(containsSecretPatterns("123456789:ABCdefGHIjklMNOpqrsTUVwxyz")).toBe(true);
  });

  it("does not false-positive on short tokens or common words", () => {
    expect(containsSecretPatterns("sk-abc")).toBe(false);
    expect(containsSecretPatterns("I have a secret to share")).toBe(false);
    expect(containsSecretPatterns("the key to success is practice")).toBe(false);
  });
});

describe("buildSecretDetectionWarning", () => {
  it("returns undefined for safe messages", () => {
    expect(buildSecretDetectionWarning("Hello world")).toBeUndefined();
    expect(buildSecretDetectionWarning("")).toBeUndefined();
  });

  it("returns a warning string when secrets are detected", () => {
    const warning = buildSecretDetectionWarning("my API_KEY=sk-abcdefgh12345678");
    expect(warning).toBeDefined();
    expect(warning).toContain("SECURITY NOTICE");
    expect(warning).toContain("credentials");
  });

  it("warning mentions openclaw config as alternative", () => {
    const warning = buildSecretDetectionWarning("SECRET=mysupersecrethunter");
    expect(warning).toBeDefined();
    expect(warning).toContain("openclaw config set");
  });

  it("warning instructs not to echo back credentials", () => {
    const warning = buildSecretDetectionWarning('{"apiKey": "test-key-value"}');
    expect(warning).toBeDefined();
    expect(warning).toContain("Do NOT repeat");
  });
});
