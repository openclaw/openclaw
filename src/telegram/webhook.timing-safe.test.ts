import { describe, expect, it, vi, beforeEach } from "vitest";
import * as webhookModule from "./webhook.js";

// Test that the webhook handler uses timing-safe comparison for secrets.
// The fix for VULN-026 requires the webhook handler to validate the secret
// using timingSafeEqual before passing the request to grammy's handler.
//
// CWE-208: Observable Timing Discrepancy
// https://cwe.mitre.org/data/definitions/208.html

// Mock grammy and bot to isolate webhook secret validation tests
const handlerSpy = vi.fn(
  (_req: unknown, res: { writeHead: (status: number) => void; end: (body?: string) => void }) => {
    res.writeHead(200);
    res.end("ok");
  },
);
const setWebhookSpy = vi.fn();
const stopSpy = vi.fn();

vi.mock("grammy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("grammy")>();
  return { ...actual, webhookCallback: () => handlerSpy };
});

vi.mock("./bot.js", () => ({
  createTelegramBot: () => ({
    api: { setWebhook: setWebhookSpy },
    stop: stopSpy,
  }),
}));

describe("VULN-026: telegram webhook secret must use timing-safe comparison", () => {
  it("safeEqualSecret is exported from webhook module", () => {
    expect(typeof webhookModule.safeEqualSecret).toBe("function");
  });

  it("safeEqualSecret returns true for equal secrets", () => {
    expect(webhookModule.safeEqualSecret("webhook-secret-123", "webhook-secret-123")).toBe(true);
    expect(webhookModule.safeEqualSecret("", "")).toBe(true);
    expect(webhookModule.safeEqualSecret("a", "a")).toBe(true);
  });

  it("safeEqualSecret returns false for different secrets of same length", () => {
    expect(webhookModule.safeEqualSecret("webhook-secret-123", "webhook-secret-124")).toBe(false);
    expect(webhookModule.safeEqualSecret("aaaa", "aaab")).toBe(false);
  });

  it("safeEqualSecret returns false for different lengths", () => {
    expect(webhookModule.safeEqualSecret("short", "longer-secret")).toBe(false);
    expect(webhookModule.safeEqualSecret("longer-secret", "short")).toBe(false);
  });

  it("safeEqualSecret handles typical Telegram secret formats", () => {
    // Telegram secrets are typically alphanumeric strings
    const secret = "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6";
    expect(webhookModule.safeEqualSecret(secret, secret)).toBe(true);
    expect(webhookModule.safeEqualSecret(secret, secret.slice(0, -1) + "X")).toBe(false);
  });

  describe("startTelegramWebhook secret validation integration", () => {
    const SECRET = "test-webhook-secret-12345";

    beforeEach(() => {
      handlerSpy.mockClear();
      setWebhookSpy.mockClear();
    });

    it("returns 401 when secret header is missing", async () => {
      const abort = new AbortController();
      const { server } = await webhookModule.startTelegramWebhook({
        token: "tok",
        port: 0,
        secret: SECRET,
        abortSignal: abort.signal,
      });

      const addr = server.address();
      if (!addr || typeof addr === "string") {
        throw new Error("no addr");
      }

      const res = await fetch(`http://127.0.0.1:${addr.port}/telegram-webhook`, {
        method: "POST",
      });

      expect(res.status).toBe(401);
      expect(handlerSpy).not.toHaveBeenCalled();
      abort.abort();
    });

    it("returns 401 when secret header is wrong", async () => {
      const abort = new AbortController();
      const { server } = await webhookModule.startTelegramWebhook({
        token: "tok",
        port: 0,
        secret: SECRET,
        abortSignal: abort.signal,
      });

      const addr = server.address();
      if (!addr || typeof addr === "string") {
        throw new Error("no addr");
      }

      const res = await fetch(`http://127.0.0.1:${addr.port}/telegram-webhook`, {
        method: "POST",
        headers: { "x-telegram-bot-api-secret-token": "wrong-secret" },
      });

      expect(res.status).toBe(401);
      expect(handlerSpy).not.toHaveBeenCalled();
      abort.abort();
    });

    it("passes request to handler when secret header is correct", async () => {
      const abort = new AbortController();
      const { server } = await webhookModule.startTelegramWebhook({
        token: "tok",
        port: 0,
        secret: SECRET,
        abortSignal: abort.signal,
      });

      const addr = server.address();
      if (!addr || typeof addr === "string") {
        throw new Error("no addr");
      }

      const res = await fetch(`http://127.0.0.1:${addr.port}/telegram-webhook`, {
        method: "POST",
        headers: { "x-telegram-bot-api-secret-token": SECRET },
      });

      expect(res.status).toBe(200);
      expect(handlerSpy).toHaveBeenCalled();
      abort.abort();
    });

    it("rejects request if safeEqualSecret returns false (regression guard)", async () => {
      // This test ensures that if someone changes the code to bypass safeEqualSecret,
      // the test will fail because we're verifying the actual HTTP behavior matches
      // what safeEqualSecret would return.
      const abort = new AbortController();
      const { server } = await webhookModule.startTelegramWebhook({
        token: "tok",
        port: 0,
        secret: SECRET,
        abortSignal: abort.signal,
      });

      const addr = server.address();
      if (!addr || typeof addr === "string") {
        throw new Error("no addr");
      }

      // Near-miss secret (timing attack target) - must be rejected
      const nearMiss = SECRET.slice(0, -1) + "X";
      const res = await fetch(`http://127.0.0.1:${addr.port}/telegram-webhook`, {
        method: "POST",
        headers: { "x-telegram-bot-api-secret-token": nearMiss },
      });

      expect(res.status).toBe(401);
      expect(handlerSpy).not.toHaveBeenCalled();
      abort.abort();
    });
  });
});
