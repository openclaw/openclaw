import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  trimToOptionalString,
  redactWebhookUrl,
  resolveCronWebhookTarget,
  buildCronWebhookHeaders,
} from "./server-cron.js";

describe("trimToOptionalString", () => {
  it("should return undefined for non-string values", () => {
    expect(trimToOptionalString(null)).toBeUndefined();
    expect(trimToOptionalString(undefined)).toBeUndefined();
    expect(trimToOptionalString(123)).toBeUndefined();
    expect(trimToOptionalString({})).toBeUndefined();
    expect(trimToOptionalString([])).toBeUndefined();
    expect(trimToOptionalString(true)).toBeUndefined();
  });

  it("should return undefined for empty string", () => {
    expect(trimToOptionalString("")).toBeUndefined();
  });

  it("should return undefined for whitespace-only string", () => {
    expect(trimToOptionalString("   ")).toBeUndefined();
    expect(trimToOptionalString("\t\n\r")).toBeUndefined();
  });

  it("should trim whitespace and return non-empty string", () => {
    expect(trimToOptionalString("  hello  ")).toBe("hello");
    expect(trimToOptionalString("\t\nhello\r\n")).toBe("hello");
  });

  it("should return string as-is if no whitespace", () => {
    expect(trimToOptionalString("hello")).toBe("hello");
    expect(trimToOptionalString("hello world")).toBe("hello world");
  });
});

describe("redactWebhookUrl", () => {
  it("should redact query parameters from URL", () => {
    const result = redactWebhookUrl("https://example.com/webhook?token=secret&key=abc");
    expect(result).toBe("https://example.com/webhook");
  });

  it("should return origin and pathname for valid URL", () => {
    const result = redactWebhookUrl("https://api.example.com/v1/webhooks/callback");
    expect(result).toBe("https://api.example.com/v1/webhooks/callback");
  });

  it("should handle URL with port", () => {
    const result = redactWebhookUrl("https://localhost:3000/webhook");
    expect(result).toBe("https://localhost:3000/webhook");
  });

  it("should handle URL with hash", () => {
    const result = redactWebhookUrl("https://example.com/webhook#section");
    expect(result).toBe("https://example.com/webhook");
  });

  it("should return placeholder for invalid URL", () => {
    const result = redactWebhookUrl("not-a-valid-url");
    expect(result).toBe("<invalid-webhook-url>");
  });

  it("should return placeholder for empty string", () => {
    const result = redactWebhookUrl("");
    expect(result).toBe("<invalid-webhook-url>");
  });

  it("should handle URL with auth credentials", () => {
    const result = redactWebhookUrl("https://user:pass@example.com/webhook");
    expect(result).toBe("https://example.com/webhook");
  });
});

describe("resolveCronWebhookTarget", () => {
  it("should return null when no webhook is configured", () => {
    const result = resolveCronWebhookTarget({});
    expect(result).toBeNull();
  });

  it("should return delivery webhook when mode is 'webhook'", () => {
    const result = resolveCronWebhookTarget({
      delivery: { mode: "webhook", to: "https://example.com/webhook" },
    });
    expect(result).toEqual({
      url: "https://example.com/webhook",
      source: "delivery",
    });
  });

  it("should normalize delivery mode to lowercase", () => {
    const result = resolveCronWebhookTarget({
      delivery: { mode: "WEBHOOK", to: "https://example.com/webhook" },
    });
    expect(result).toEqual({
      url: "https://example.com/webhook",
      source: "delivery",
    });
  });

  it("should trim whitespace from delivery mode", () => {
    const result = resolveCronWebhookTarget({
      delivery: { mode: "  webhook  ", to: "https://example.com/webhook" },
    });
    expect(result).toEqual({
      url: "https://example.com/webhook",
      source: "delivery",
    });
  });

  it("should return null for webhook mode without URL", () => {
    const result = resolveCronWebhookTarget({
      delivery: { mode: "webhook" },
    });
    expect(result).toBeNull();
  });

  it("should return legacy webhook when legacyNotify is true", () => {
    const result = resolveCronWebhookTarget({
      legacyNotify: true,
      legacyWebhook: "https://legacy.example.com/webhook",
    });
    expect(result).toEqual({
      url: "https://legacy.example.com/webhook",
      source: "legacy",
    });
  });

  it("should prefer delivery over legacy when both are set", () => {
    const result = resolveCronWebhookTarget({
      delivery: { mode: "webhook", to: "https://delivery.example.com/webhook" },
      legacyNotify: true,
      legacyWebhook: "https://legacy.example.com/webhook",
    });
    expect(result).toEqual({
      url: "https://delivery.example.com/webhook",
      source: "delivery",
    });
  });

  it("should return null for legacy when legacyNotify is false", () => {
    const result = resolveCronWebhookTarget({
      legacyNotify: false,
      legacyWebhook: "https://legacy.example.com/webhook",
    });
    expect(result).toBeNull();
  });

  it("should return null for legacy without webhook URL", () => {
    const result = resolveCronWebhookTarget({
      legacyNotify: true,
    });
    expect(result).toBeNull();
  });

  it("should normalize HTTP webhook URL", () => {
    const result = resolveCronWebhookTarget({
      delivery: { mode: "webhook", to: "HTTP://EXAMPLE.COM/WEBHOOK" },
    });
    expect(result?.url).toBe("http://example.com/WEBHOOK");
  });
});

describe("buildCronWebhookHeaders", () => {
  it("should return Content-Type header by default", () => {
    const result = buildCronWebhookHeaders();
    expect(result).toEqual({
      "Content-Type": "application/json",
    });
  });

  it("should include Authorization header when token is provided", () => {
    const result = buildCronWebhookHeaders("my-secret-token");
    expect(result).toEqual({
      "Content-Type": "application/json",
      Authorization: "Bearer my-secret-token",
    });
  });

  it("should handle empty string token", () => {
    const result = buildCronWebhookHeaders("");
    expect(result).toEqual({
      "Content-Type": "application/json",
    });
  });

  it("should handle token with special characters", () => {
    const result = buildCronWebhookHeaders("token-with-special_chars.123");
    expect(result.Authorization).toBe("Bearer token-with-special_chars.123");
  });
});
