import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createFirecrawlBrowserSession,
  deleteFirecrawlBrowserSession,
  isFirecrawlSessionReachable,
} from "./firecrawl-browser.js";

describe("firecrawl-browser", () => {
  const baseParams = {
    apiKey: "fc-test-key",
    baseUrl: "https://api.firecrawl.dev",
  };

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("createFirecrawlBrowserSession", () => {
    it("calls the v2 endpoint with auth header", async () => {
      const mockResponse = {
        success: true,
        id: "sess-123",
        cdpUrl: "wss://connect.firecrawl.dev/sess-123",
        liveViewUrl: "https://connect.firecrawl.dev/v/sess-123",
        expiresAt: "2026-03-02T12:00:00Z",
      };
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      });

      const session = await createFirecrawlBrowserSession(baseParams);

      expect(fetch).toHaveBeenCalledWith(
        "https://api.firecrawl.dev/v2/browser",
        expect.objectContaining({
          method: "POST",
          headers: {
            Authorization: "Bearer fc-test-key",
            "Content-Type": "application/json",
          },
        }),
      );
      expect(session.sessionId).toBe("sess-123");
      expect(session.cdpWebSocketUrl).toBe("wss://connect.firecrawl.dev/sess-123");
      expect(session.liveViewUrl).toBe("https://connect.firecrawl.dev/v/sess-123");
      expect(session.expiresAt).toBe("2026-03-02T12:00:00Z");
    });

    it("passes optional TTL and streaming params in request body", async () => {
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: async () => ({
          id: "sess-456",
          cdpUrl: "wss://connect.firecrawl.dev/sess-456",
        }),
      });

      await createFirecrawlBrowserSession({
        ...baseParams,
        ttlTotal: 600,
        ttlWithoutActivity: 120,
        streamWebView: true,
      });

      const body = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
      expect(body.ttlTotal).toBe(600);
      expect(body.ttlWithoutActivity).toBe(120);
      expect(body.streamWebView).toBe(true);
    });

    it("sends empty body when no optional params are provided", async () => {
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: async () => ({
          id: "sess-min",
          cdpUrl: "wss://connect.firecrawl.dev/sess-min",
        }),
      });

      await createFirecrawlBrowserSession(baseParams);

      const body = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
      expect(body).toEqual({});
    });

    it("strips trailing slash from baseUrl", async () => {
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: async () => ({
          id: "sess-slash",
          cdpUrl: "wss://connect.firecrawl.dev/sess-slash",
        }),
      });

      await createFirecrawlBrowserSession({
        apiKey: "fc-key",
        baseUrl: "https://api.firecrawl.dev/",
      });

      expect(fetch).toHaveBeenCalledWith(
        "https://api.firecrawl.dev/v2/browser",
        expect.anything(),
      );
    });

    it("works with custom baseUrl", async () => {
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: async () => ({
          id: "sess-custom",
          cdpUrl: "wss://custom.host/sess-custom",
        }),
      });

      await createFirecrawlBrowserSession({
        apiKey: "fc-key",
        baseUrl: "https://custom.host:8080",
      });

      expect(fetch).toHaveBeenCalledWith(
        "https://custom.host:8080/v2/browser",
        expect.anything(),
      );
    });

    it("defaults liveViewUrl to empty string when missing from response", async () => {
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: async () => ({
          id: "sess-no-liveview",
          cdpUrl: "wss://connect.firecrawl.dev/sess-no-liveview",
        }),
      });

      const session = await createFirecrawlBrowserSession(baseParams);
      expect(session.liveViewUrl).toBe("");
    });

    it("leaves expiresAt undefined when missing from response", async () => {
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: async () => ({
          id: "sess-no-expiry",
          cdpUrl: "wss://connect.firecrawl.dev/sess-no-expiry",
        }),
      });

      const session = await createFirecrawlBrowserSession(baseParams);
      expect(session.expiresAt).toBeUndefined();
    });

    it("throws on HTTP 401 Unauthorized", async () => {
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        text: async () => "Invalid API key",
      });

      await expect(createFirecrawlBrowserSession(baseParams)).rejects.toThrow(
        "Firecrawl browser session create failed (HTTP 401): Invalid API key",
      );
    });

    it("throws on HTTP 429 rate limit", async () => {
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: false,
        status: 429,
        statusText: "Too Many Requests",
        text: async () => "Rate limit exceeded",
      });

      await expect(createFirecrawlBrowserSession(baseParams)).rejects.toThrow(
        "Firecrawl browser session create failed (HTTP 429)",
      );
    });

    it("throws on HTTP 500 server error", async () => {
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        text: async () => "",
      });

      await expect(createFirecrawlBrowserSession(baseParams)).rejects.toThrow(
        "Firecrawl browser session create failed (HTTP 500): Internal Server Error",
      );
    });

    it("falls back to statusText when response body read fails", async () => {
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: false,
        status: 503,
        statusText: "Service Unavailable",
        text: async () => {
          throw new Error("body read failed");
        },
      });

      await expect(createFirecrawlBrowserSession(baseParams)).rejects.toThrow(
        "Firecrawl browser session create failed (HTTP 503): Service Unavailable",
      );
    });

    it("throws when response is missing id", async () => {
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: async () => ({
          success: true,
          cdpUrl: "wss://connect.firecrawl.dev/xxx",
        }),
      });

      await expect(createFirecrawlBrowserSession(baseParams)).rejects.toThrow(
        "missing id or cdpUrl",
      );
    });

    it("throws when response is missing cdpUrl", async () => {
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: async () => ({
          success: true,
          id: "sess-no-ws",
        }),
      });

      await expect(createFirecrawlBrowserSession(baseParams)).rejects.toThrow(
        "missing id or cdpUrl",
      );
    });

    it("throws when response is completely empty object", async () => {
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: async () => ({}),
      });

      await expect(createFirecrawlBrowserSession(baseParams)).rejects.toThrow(
        "missing id or cdpUrl",
      );
    });

    it("propagates network errors from fetch", async () => {
      (fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("network failure"));

      await expect(createFirecrawlBrowserSession(baseParams)).rejects.toThrow("network failure");
    });

    it("maps API response fields to internal names", async () => {
      // The v2 API returns { id, cdpUrl, liveViewUrl } but our internal type
      // uses { sessionId, cdpWebSocketUrl, liveViewUrl } for clarity.
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: async () => ({
          success: true,
          id: "api-id-field",
          cdpUrl: "wss://api-cdp-field",
          liveViewUrl: "https://api-liveview-field",
          expiresAt: "2026-12-31T00:00:00Z",
        }),
      });

      const session = await createFirecrawlBrowserSession(baseParams);
      // id → sessionId
      expect(session.sessionId).toBe("api-id-field");
      // cdpUrl → cdpWebSocketUrl
      expect(session.cdpWebSocketUrl).toBe("wss://api-cdp-field");
      // liveViewUrl → liveViewUrl (same)
      expect(session.liveViewUrl).toBe("https://api-liveview-field");
    });
  });

  describe("deleteFirecrawlBrowserSession", () => {
    it("calls the v2 endpoint with DELETE method", async () => {
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });

      await deleteFirecrawlBrowserSession({
        ...baseParams,
        sessionId: "sess-789",
      });

      expect(fetch).toHaveBeenCalledWith(
        "https://api.firecrawl.dev/v2/browser/sess-789",
        expect.objectContaining({
          method: "DELETE",
          headers: { Authorization: "Bearer fc-test-key" },
        }),
      );
    });

    it("URL-encodes session IDs with special characters", async () => {
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });

      await deleteFirecrawlBrowserSession({
        ...baseParams,
        sessionId: "sess/with+special chars",
      });

      expect(fetch).toHaveBeenCalledWith(
        "https://api.firecrawl.dev/v2/browser/sess%2Fwith%2Bspecial%20chars",
        expect.anything(),
      );
    });

    it("strips trailing slash from baseUrl", async () => {
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });

      await deleteFirecrawlBrowserSession({
        apiKey: "fc-key",
        baseUrl: "https://api.firecrawl.dev/",
        sessionId: "sess-100",
      });

      expect(fetch).toHaveBeenCalledWith(
        "https://api.firecrawl.dev/v2/browser/sess-100",
        expect.anything(),
      );
    });

    it("throws on HTTP 404 Not Found", async () => {
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: false,
        status: 404,
        statusText: "Not Found",
        text: async () => "Session not found",
      });

      await expect(
        deleteFirecrawlBrowserSession({ ...baseParams, sessionId: "sess-bad" }),
      ).rejects.toThrow("Firecrawl browser session delete failed (HTTP 404): Session not found");
    });

    it("falls back to statusText when body read fails on error", async () => {
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        text: async () => {
          throw new Error("body read failed");
        },
      });

      await expect(
        deleteFirecrawlBrowserSession({ ...baseParams, sessionId: "sess-err" }),
      ).rejects.toThrow(
        "Firecrawl browser session delete failed (HTTP 500): Internal Server Error",
      );
    });

    it("propagates network errors from fetch", async () => {
      (fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("connection refused"));

      await expect(
        deleteFirecrawlBrowserSession({ ...baseParams, sessionId: "sess-net" }),
      ).rejects.toThrow("connection refused");
    });
  });

  describe("isFirecrawlSessionReachable", () => {
    it("returns false for invalid URLs", async () => {
      const result = await isFirecrawlSessionReachable("not-a-url", 500);
      expect(result).toBe(false);
    });

    it("returns false for empty string URL", async () => {
      const result = await isFirecrawlSessionReachable("", 500);
      expect(result).toBe(false);
    });
  });
});
