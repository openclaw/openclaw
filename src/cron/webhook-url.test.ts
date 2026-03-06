import { describe, expect, it } from "vitest";
import { validateHttpWebhookUrl, normalizeHttpWebhookUrl } from "./webhook-url.js";

describe("validateHttpWebhookUrl", () => {
  it("accepts valid https URL", () => {
    const r = validateHttpWebhookUrl("https://example.com/hook");
    expect(r).toEqual({ ok: true, url: "https://example.com/hook" });
  });

  it("accepts valid http URL", () => {
    const r = validateHttpWebhookUrl("http://localhost:3000/callback");
    expect(r).toEqual({ ok: true, url: "http://localhost:3000/callback" });
  });

  it("rejects non-string with reason", () => {
    const r = validateHttpWebhookUrl(42);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("expected string");
    }
  });

  it("rejects empty string with reason", () => {
    const r = validateHttpWebhookUrl("   ");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("empty URL");
    }
  });

  it("rejects malformed URL with reason", () => {
    const r = validateHttpWebhookUrl("not-a-url");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("malformed URL");
    }
  });

  it("rejects ftp scheme with reason", () => {
    const r = validateHttpWebhookUrl("ftp://files.example.com/data");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("blocked scheme");
    }
  });

  it("rejects file scheme with reason", () => {
    const r = validateHttpWebhookUrl("file:///etc/passwd");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("blocked scheme");
    }
  });

  it("rejects javascript scheme with reason", () => {
    // eslint-disable-next-line no-script-url
    const r = validateHttpWebhookUrl("javascript:alert(1)");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("blocked scheme");
    }
  });
});

describe("normalizeHttpWebhookUrl (legacy compat)", () => {
  it("returns URL string for valid input", () => {
    expect(normalizeHttpWebhookUrl("https://example.com")).toBe("https://example.com");
  });

  it("returns null for invalid input", () => {
    expect(normalizeHttpWebhookUrl("ftp://bad")).toBeNull();
    expect(normalizeHttpWebhookUrl("")).toBeNull();
    expect(normalizeHttpWebhookUrl(undefined)).toBeNull();
  });
});
