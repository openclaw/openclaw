import { describe, expect, it } from "vitest";
import { REDACTED_SENTINEL, detectPlaceholderSecrets } from "./redact-snapshot.js";
import type { ConfigUiHints } from "./schema.js";

describe("detectPlaceholderSecrets", () => {
  it("detects common placeholder patterns on sensitive paths", () => {
    const placeholders = [
      "REDACTED",
      "redacted",
      "xoxb-REDACTED",
      "xapp-REDACTED",
      "sk-redacted",
      "sk-proj-REDACTED",
      "xoxb-REPLACE_ME",
      "xapp-REPLACE_ME",
      "sk-proj-placeholder",
      "your-token-here",
      "your_api_key_here",
      "changeme",
      "replace-me",
      "PLACEHOLDER",
      "xxx",
      "XXXXX",
      "TODO",
      "N/A",
      "n/a",
    ];
    for (const placeholder of placeholders) {
      const config = { channels: { slack: { token: placeholder } } };
      const result = detectPlaceholderSecrets(config);
      expect(result.ok, `expected "${placeholder}" to be detected`).toBe(false);
      expect(result.paths.length).toBeGreaterThan(0);
    }
  });

  it("accepts real credential values on sensitive paths", () => {
    const realValues = [
      "xoxb-real-credential-value-abc123",
      "sk-proj-abcdef1234567890ghij",
      "MTIzNDU2Nzg5MDEyMzQ1Njc4.GaBcDe.FgH",
      "gsk_abc123def456ghi789jkl012mno",
      "my-actual-secret-key-2024",
      "my-redacted-token-v2", // legit value containing "redacted" as substring
    ];
    for (const value of realValues) {
      const config = { channels: { slack: { token: value } } };
      const result = detectPlaceholderSecrets(config);
      expect(result.ok, `expected "${value}" to pass`).toBe(true);
    }
  });

  it("ignores placeholder values on non-sensitive paths", () => {
    const config = { ui: { seamColor: "REDACTED" }, gateway: { port: 18789 } };
    const result = detectPlaceholderSecrets(config);
    expect(result.ok).toBe(true);
  });

  it("reports the offending path", () => {
    const config = { gateway: { auth: { token: "REDACTED" } } };
    const result = detectPlaceholderSecrets(config);
    expect(result.ok).toBe(false);
    expect(result.paths).toContain("gateway.auth.token");
  });

  it("respects uiHints sensitive:false override", () => {
    const hints: ConfigUiHints = { "gateway.auth.token": { sensitive: false } };
    const config = { gateway: { auth: { token: "REDACTED" } } };
    const result = detectPlaceholderSecrets(config, hints);
    expect(result.ok).toBe(true);
  });

  it("does not flag the official REDACTED_SENTINEL", () => {
    const config = { channels: { slack: { token: REDACTED_SENTINEL } } };
    const result = detectPlaceholderSecrets(config);
    expect(result.ok).toBe(true);
  });

  it("handles null/undefined/non-object input gracefully", () => {
    expect(detectPlaceholderSecrets(null).ok).toBe(true);
    expect(detectPlaceholderSecrets(undefined).ok).toBe(true);
    expect(detectPlaceholderSecrets("string").ok).toBe(true);
  });

  it("detects placeholders with uiHints lookup path", () => {
    const hints: ConfigUiHints = { "custom.mySecret": { sensitive: true } };
    const config = { custom: { mySecret: "your-secret-here" } };
    const result = detectPlaceholderSecrets(config, hints);
    expect(result.ok).toBe(false);
    expect(result.paths).toContain("custom.mySecret");
  });

  it("accepts valid values with uiHints lookup path", () => {
    const hints: ConfigUiHints = { "custom.mySecret": { sensitive: true } };
    const config = { custom: { mySecret: "real-api-key-abc123def456" } };
    const result = detectPlaceholderSecrets(config, hints);
    expect(result.ok).toBe(true);
  });
});
