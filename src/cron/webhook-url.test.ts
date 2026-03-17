import { describe, expect, it } from "vitest";
import { normalizeHttpWebhookUrl } from "./webhook-url.js";

describe("normalizeHttpWebhookUrl", () => {
  it("accepts valid https URLs", () => {
    expect(normalizeHttpWebhookUrl("https://example.com/webhook")).toBe(
      "https://example.com/webhook",
    );
  });

  it("accepts valid http URLs", () => {
    expect(normalizeHttpWebhookUrl("http://hooks.example.com/cron")).toBe(
      "http://hooks.example.com/cron",
    );
  });

  it("trims whitespace", () => {
    expect(normalizeHttpWebhookUrl("  https://example.com/hook  ")).toBe(
      "https://example.com/hook",
    );
  });

  it("rejects non-string input", () => {
    expect(normalizeHttpWebhookUrl(42)).toBeNull();
    expect(normalizeHttpWebhookUrl(null)).toBeNull();
    expect(normalizeHttpWebhookUrl(undefined)).toBeNull();
    expect(normalizeHttpWebhookUrl({})).toBeNull();
  });

  it("rejects empty strings", () => {
    expect(normalizeHttpWebhookUrl("")).toBeNull();
    expect(normalizeHttpWebhookUrl("   ")).toBeNull();
  });

  it("rejects non-http(s) protocols", () => {
    expect(normalizeHttpWebhookUrl("ftp://example.com/hook")).toBeNull();
    expect(normalizeHttpWebhookUrl("file:///etc/passwd")).toBeNull();
    expect(normalizeHttpWebhookUrl("javascript:alert(1)")).toBeNull();
  });

  it("rejects malformed URLs", () => {
    expect(normalizeHttpWebhookUrl("not-a-url")).toBeNull();
    expect(normalizeHttpWebhookUrl("://missing-scheme")).toBeNull();
  });

  // SSRF guard: private/internal addresses
  it("rejects localhost", () => {
    expect(normalizeHttpWebhookUrl("http://localhost/hook")).toBeNull();
    expect(normalizeHttpWebhookUrl("http://localhost:8080/hook")).toBeNull();
    expect(normalizeHttpWebhookUrl("https://localhost/hook")).toBeNull();
  });

  it("rejects loopback IPv4", () => {
    expect(normalizeHttpWebhookUrl("http://127.0.0.1/hook")).toBeNull();
    expect(normalizeHttpWebhookUrl("http://127.0.0.1:3000/hook")).toBeNull();
  });

  it("rejects loopback IPv6", () => {
    expect(normalizeHttpWebhookUrl("http://[::1]/hook")).toBeNull();
    expect(normalizeHttpWebhookUrl("http://[::1]:8080/hook")).toBeNull();
  });

  it("rejects private RFC 1918 ranges", () => {
    expect(normalizeHttpWebhookUrl("http://10.0.0.1/hook")).toBeNull();
    expect(normalizeHttpWebhookUrl("http://172.16.0.1/hook")).toBeNull();
    expect(normalizeHttpWebhookUrl("http://192.168.1.1/hook")).toBeNull();
  });

  it("rejects link-local addresses", () => {
    expect(normalizeHttpWebhookUrl("http://169.254.169.254/latest/meta-data/")).toBeNull();
  });

  it("rejects cloud metadata endpoints", () => {
    expect(
      normalizeHttpWebhookUrl("http://metadata.google.internal/computeMetadata/v1/"),
    ).toBeNull();
  });

  it("rejects .local and .internal hostnames", () => {
    expect(normalizeHttpWebhookUrl("http://myservice.local/hook")).toBeNull();
    expect(normalizeHttpWebhookUrl("http://secret.internal/hook")).toBeNull();
  });

  it("allows public IPs", () => {
    expect(normalizeHttpWebhookUrl("https://8.8.8.8/hook")).toBe("https://8.8.8.8/hook");
  });
});
