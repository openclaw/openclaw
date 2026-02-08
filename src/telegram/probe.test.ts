import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { probeTelegram } from "./probe.js";

// Stub fetch globally
const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

describe("probeTelegram", () => {
  it("returns ok when getMe and getWebhookInfo succeed with no errors", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          result: { id: 123, username: "testbot" },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          result: { url: "https://example.com/webhook", has_custom_certificate: false },
        }),
      );

    const result = await probeTelegram("fake-token", 5000);

    expect(result.ok).toBe(true);
    expect(result.bot?.username).toBe("testbot");
    expect(result.webhook?.url).toBe("https://example.com/webhook");
    expect(result.webhook?.pendingUpdateCount).toBeNull();
    expect(result.webhook?.lastErrorDate).toBeNull();
    expect(result.webhook?.lastErrorMessage).toBeNull();
  });

  it("returns ok:false when getMe fails", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: false, description: "Unauthorized" }, 401));

    const result = await probeTelegram("bad-token", 5000);

    expect(result.ok).toBe(false);
    expect(result.error).toBe("Unauthorized");
    expect(result.status).toBe(401);
  });

  it("returns ok:false when webhook has a recent error", async () => {
    const recentErrorDate = Math.floor(Date.now() / 1000) - 60; // 1 minute ago

    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          result: { id: 123, username: "testbot" },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          result: {
            url: "https://example.com/webhook",
            has_custom_certificate: false,
            pending_update_count: 42,
            last_error_date: recentErrorDate,
            last_error_message: "Connection refused",
          },
        }),
      );

    const result = await probeTelegram("fake-token", 5000);

    expect(result.ok).toBe(false);
    expect(result.error).toBe("webhook error: Connection refused");
    expect(result.webhook?.pendingUpdateCount).toBe(42);
    expect(result.webhook?.lastErrorDate).toBe(recentErrorDate);
    expect(result.webhook?.lastErrorMessage).toBe("Connection refused");
  });

  it("returns ok:true when webhook error is older than 10 minutes", async () => {
    const oldErrorDate = Math.floor(Date.now() / 1000) - 700; // ~12 minutes ago

    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          result: { id: 123, username: "testbot" },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          result: {
            url: "https://example.com/webhook",
            has_custom_certificate: false,
            pending_update_count: 0,
            last_error_date: oldErrorDate,
            last_error_message: "Connection refused",
          },
        }),
      );

    const result = await probeTelegram("fake-token", 5000);

    expect(result.ok).toBe(true);
    expect(result.error).toBeNull();
    expect(result.webhook?.lastErrorDate).toBe(oldErrorDate);
  });

  it("returns ok:true in polling mode even with recent webhook errors (no active webhook URL)", async () => {
    const recentErrorDate = Math.floor(Date.now() / 1000) - 60; // 1 minute ago

    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          result: { id: 123, username: "testbot" },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          result: {
            url: "", // empty URL = polling mode
            has_custom_certificate: false,
            pending_update_count: 2,
            last_error_date: recentErrorDate,
            last_error_message: "Wrong response from the webhook: 500 INTERNAL SERVER ERROR",
          },
        }),
      );

    const result = await probeTelegram("fake-token", 5000);

    expect(result.ok).toBe(true);
    expect(result.error).toBeNull();
    expect(result.webhook?.url).toBe("");
    expect(result.webhook?.lastErrorDate).toBe(recentErrorDate);
  });

  it("still returns ok:true when getWebhookInfo request itself fails", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          result: { id: 123, username: "testbot" },
        }),
      )
      .mockRejectedValueOnce(new Error("network timeout"));

    const result = await probeTelegram("fake-token", 5000);

    expect(result.ok).toBe(true);
    expect(result.bot?.username).toBe("testbot");
  });
});
