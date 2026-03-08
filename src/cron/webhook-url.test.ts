import { describe, expect, it } from "vitest";
import { normalizeHttpWebhookUrl } from "./webhook-url.js";

describe("normalizeHttpWebhookUrl", () => {
  it("accepts valid http URLs", () => {
    expect(normalizeHttpWebhookUrl("http://example.com/webhook")).toBe(
      "http://example.com/webhook",
    );
  });

  it("accepts valid https URLs", () => {
    expect(normalizeHttpWebhookUrl("https://example.com/webhook")).toBe(
      "https://example.com/webhook",
    );
  });

  it("preserves query params and fragments", () => {
    const url = "https://example.com/hook?key=abc&channel=test#ref";
    expect(normalizeHttpWebhookUrl(url)).toBe(url);
  });

  it("rejects ftp protocol", () => {
    expect(normalizeHttpWebhookUrl("ftp://example.com/file")).toBeNull();
  });

  it("rejects file protocol", () => {
    expect(normalizeHttpWebhookUrl("file:///etc/passwd")).toBeNull();
  });

  it("rejects javascript protocol", () => {
    expect(normalizeHttpWebhookUrl("javascript:alert(1)")).toBeNull();
  });

  it("rejects data protocol", () => {
    expect(normalizeHttpWebhookUrl("data:text/html,<script>alert(1)</script>")).toBeNull();
  });

  it("rejects empty string", () => {
    expect(normalizeHttpWebhookUrl("")).toBeNull();
  });

  it("rejects whitespace-only string", () => {
    expect(normalizeHttpWebhookUrl("   ")).toBeNull();
  });

  it("rejects null and undefined", () => {
    expect(normalizeHttpWebhookUrl(null)).toBeNull();
    expect(normalizeHttpWebhookUrl(undefined)).toBeNull();
  });

  it("rejects non-string values", () => {
    expect(normalizeHttpWebhookUrl(42)).toBeNull();
    expect(normalizeHttpWebhookUrl(true)).toBeNull();
    expect(normalizeHttpWebhookUrl({})).toBeNull();
  });

  it("rejects malformed URLs", () => {
    expect(normalizeHttpWebhookUrl("not-a-url")).toBeNull();
    expect(normalizeHttpWebhookUrl("://missing-scheme")).toBeNull();
  });

  it("trims whitespace from valid URLs", () => {
    expect(normalizeHttpWebhookUrl("  https://example.com/hook  ")).toBe(
      "https://example.com/hook",
    );
  });
});
