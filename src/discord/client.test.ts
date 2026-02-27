import { RateLimitError } from "@buape/carbon";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { ProxiedRequestClient, createDiscordRestClient, createDiscordClient } from "./client.js";
import { buildQueryString } from "./client.js";

const { proxyFetchMock, loadConfigMock, resolveDiscordAccountMock, createDiscordRetryRunnerMock } =
  vi.hoisted(() => ({
    proxyFetchMock: vi.fn(),
    loadConfigMock: vi.fn(),
    resolveDiscordAccountMock: vi.fn(),
    createDiscordRetryRunnerMock: vi.fn(() => vi.fn()),
  }));

vi.mock("./proxy.js", () => ({
  makeDiscordProxyFetch: vi.fn(() => proxyFetchMock),
}));

vi.mock("../config/config.js", () => ({
  loadConfig: loadConfigMock,
}));

vi.mock("./accounts.js", () => ({
  resolveDiscordAccount: resolveDiscordAccountMock,
}));

vi.mock("../infra/retry-policy.js", () => ({
  createDiscordRetryRunner: createDiscordRetryRunnerMock,
}));

describe("ProxiedRequestClient", () => {
  const testToken = "test-token-12345";
  const testProxyUrl = "http://proxy.example.com:8080";
  let client: ProxiedRequestClient;

  beforeEach(() => {
    proxyFetchMock.mockClear();
    proxyFetchMock.mockResolvedValue(new Response(JSON.stringify({ id: "123" }), { status: 200 }));
    client = new ProxiedRequestClient(testToken, testProxyUrl);
  });

  describe("constructor", () => {
    it("creates a client with the provided token and proxy URL", () => {
      expect(client).toBeInstanceOf(ProxiedRequestClient);
    });
  });

  describe("get", () => {
    it("makes a GET request with correct headers", async () => {
      await client.get("/users/@me");

      expect(proxyFetchMock).toHaveBeenCalledWith(
        "https://discord.com/api/v10/users/@me",
        expect.objectContaining({
          method: "GET",
          headers: expect.any(Headers),
        }),
      );

      const call = proxyFetchMock.mock.calls[0];
      const headers = call[1]?.headers as Headers;
      expect(headers.get("Authorization")).toBe("Bot test-token-12345");
      // User-Agent is set by Carbon's RequestClient and includes version info
      expect(headers.get("User-Agent")).toContain("DiscordBot");
    });

    it("makes a GET request with query parameters", async () => {
      await client.get("/guilds/123/messages", { limit: 50, after: "456" });

      expect(proxyFetchMock).toHaveBeenCalledWith(
        "https://discord.com/api/v10/guilds/123/messages?limit=50&after=456",
        expect.any(Object),
      );
    });

    it("encodes query parameters correctly", async () => {
      await client.get("/search", { q: "hello world", filter: "a&b=1" });

      const url = proxyFetchMock.mock.calls[0][0] as string;
      expect(url).toContain("q=hello%20world");
      expect(url).toContain("filter=a%26b%3D1");
    });

    it("handles array query parameters with comma-separated values (Discord API style)", async () => {
      await client.get("/guilds/123/members", { roles: ["111", "222", "333"] });

      const url = proxyFetchMock.mock.calls[0][0] as string;
      // Discord API uses comma-separated values for array params
      expect(url).toContain("roles=111,222,333");
    });

    it("handles mixed array and scalar query parameters", async () => {
      await client.get("/search", { q: "test", ids: ["1", "2"], limit: 10 });

      const url = proxyFetchMock.mock.calls[0][0] as string;
      expect(url).toContain("q=test");
      expect(url).toContain("ids=1,2");
      expect(url).toContain("limit=10");
    });

    it("handles empty array query parameters", async () => {
      await client.get("/search", { roles: [] });

      const url = proxyFetchMock.mock.calls[0][0] as string;
      // Empty arrays should not add any parameter
      expect(url).not.toContain("roles=");
    });

    it("handles numeric array query parameters", async () => {
      await client.get("/search", { ids: [1, 2, 3] });

      const url = proxyFetchMock.mock.calls[0][0] as string;
      expect(url).toContain("ids=1,2,3");
    });

    it("returns parsed JSON response", async () => {
      proxyFetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "123", username: "testuser" }), { status: 200 }),
      );

      const result = (await client.get("/users/@me")) as { id: string; username: string };

      expect(result).toEqual({ id: "123", username: "testuser" });
    });
  });

  describe("post", () => {
    it("makes a POST request with JSON body", async () => {
      proxyFetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "msg123" }), { status: 200 }),
      );

      await client.post("/channels/123/messages", {
        body: { content: "Hello, World!" },
      });

      expect(proxyFetchMock).toHaveBeenCalledWith(
        "https://discord.com/api/v10/channels/123/messages",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ content: "Hello, World!" }),
        }),
      );

      const call = proxyFetchMock.mock.calls[0];
      const headers = call[1]?.headers as Headers;
      expect(headers.get("Content-Type")).toBe("application/json");
    });

    it("makes a POST request with query parameters", async () => {
      await client.post("/channels/123/messages", { body: { content: "Test" } }, { tts: false });

      expect(proxyFetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/channels/123/messages?tts=false"),
        expect.any(Object),
      );
    });

    it("supports rawBody option", async () => {
      const rawBody = new TextEncoder().encode("raw data");

      await client.post("/upload", { body: rawBody, rawBody: true });

      const call = proxyFetchMock.mock.calls[0];
      const headers = call[1]?.headers as Headers;
      expect(headers.get("Content-Type")).toBeNull();
    });

    it("supports custom headers", async () => {
      await client.post("/channels/123/messages", {
        body: { content: "Test" },
        headers: { "X-Custom-Header": "custom-value" },
      });

      const call = proxyFetchMock.mock.calls[0];
      const headers = call[1]?.headers as Headers;
      expect(headers.get("X-Custom-Header")).toBe("custom-value");
    });
  });

  describe("patch", () => {
    it("makes a PATCH request with JSON body", async () => {
      proxyFetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ content: "Edited" }), { status: 200 }),
      );

      await client.patch("/channels/123/messages/456", {
        body: { content: "Edited message" },
      });

      expect(proxyFetchMock).toHaveBeenCalledWith(
        "https://discord.com/api/v10/channels/123/messages/456",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ content: "Edited message" }),
        }),
      );
    });
  });

  describe("put", () => {
    it("makes a PUT request with JSON body", async () => {
      proxyFetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

      await client.put("/channels/123/permissions/456", {
        body: { allow: "1", deny: "0" },
      });

      expect(proxyFetchMock).toHaveBeenCalledWith(
        "https://discord.com/api/v10/channels/123/permissions/456",
        expect.objectContaining({
          method: "PUT",
          body: JSON.stringify({ allow: "1", deny: "0" }),
        }),
      );
    });

    it("returns undefined for 204 No Content response", async () => {
      proxyFetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

      const result = await client.put("/channels/123/permissions/456", { body: { test: 1 } });

      expect(result).toBeUndefined();
    });
  });

  describe("delete", () => {
    it("makes a DELETE request", async () => {
      proxyFetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

      await client.delete("/channels/123/messages/456");

      expect(proxyFetchMock).toHaveBeenCalledWith(
        "https://discord.com/api/v10/channels/123/messages/456",
        expect.objectContaining({
          method: "DELETE",
        }),
      );
    });

    it("makes a DELETE request with body", async () => {
      proxyFetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

      await client.delete("/channels/123/messages/bulk-delete", {
        body: { messages: ["1", "2", "3"] },
      });

      expect(proxyFetchMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          method: "DELETE",
          body: JSON.stringify({ messages: ["1", "2", "3"] }),
        }),
      );
    });
  });

  describe("error handling", () => {
    it("throws an error with status code on non-OK response", async () => {
      proxyFetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ message: "Unauthorized" }), { status: 401 }),
      );

      await expect(client.get("/users/@me")).rejects.toThrow("Discord API error (401)");
    });

    it("throws an error with response text on 500 error", async () => {
      proxyFetchMock.mockResolvedValueOnce(new Response("Internal Server Error", { status: 500 }));

      try {
        await client.get("/users/@me");
        expect.fail("Expected error to be thrown");
      } catch (err) {
        expect((err as Error).message).toContain("Discord API error (500)");
        expect((err as Error).message).toContain("Internal Server Error");
      }
    });

    it("truncates long error messages", async () => {
      const longMessage = "x".repeat(1000);
      proxyFetchMock.mockResolvedValueOnce(new Response(longMessage, { status: 500 }));

      try {
        await client.get("/users/@me");
        expect.fail("Expected error to be thrown");
      } catch (err) {
        const message = (err as Error).message;
        expect(message.length).toBeLessThan(600); // Should be truncated to ~500 chars + prefix
      }
    });

    it("handles network errors", async () => {
      proxyFetchMock.mockRejectedValueOnce(new Error("Network error"));

      await expect(client.get("/users/@me")).rejects.toThrow("Network error");
    });

    it("throws RateLimitError on 429 response with retry_after in body", async () => {
      proxyFetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            message: "You are being rate limited.",
            retry_after: 2.5,
            global: false,
          }),
          {
            status: 429,
            headers: {
              "X-RateLimit-Scope": "user",
              "X-RateLimit-Bucket": "abc123",
            },
          },
        ),
      );

      try {
        await client.get("/users/@me");
        expect.fail("Expected RateLimitError to be thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(RateLimitError);
        const rateLimitErr = err as RateLimitError;
        expect(rateLimitErr.retryAfter).toBe(2.5);
        expect(rateLimitErr.status).toBe(429);
      }
    });

    it("throws RateLimitError on 429 response with Retry-After header", async () => {
      proxyFetchMock.mockResolvedValueOnce(
        new Response("You are being rate limited.", {
          status: 429,
          headers: {
            "Retry-After": "5",
            "X-RateLimit-Scope": "global",
          },
        }),
      );

      try {
        await client.get("/users/@me");
        expect.fail("Expected RateLimitError to be thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(RateLimitError);
        const rateLimitErr = err as RateLimitError;
        expect(rateLimitErr.retryAfter).toBe(5);
        expect(rateLimitErr.status).toBe(429);
      }
    });

    it("throws RateLimitError with default retry_after on 429 without retry info", async () => {
      proxyFetchMock.mockResolvedValueOnce(
        new Response("Rate limited", {
          status: 429,
        }),
      );

      try {
        await client.get("/users/@me");
        expect.fail("Expected RateLimitError to be thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(RateLimitError);
        const rateLimitErr = err as RateLimitError;
        expect(rateLimitErr.retryAfter).toBe(1); // Default fallback
        expect(rateLimitErr.status).toBe(429);
      }
    });

    it("throws RateLimitError with retry_after from X-RateLimit-Reset header", async () => {
      // X-RateLimit-Reset is a Unix timestamp in seconds
      const nowSeconds = Math.floor(Date.now() / 1000);
      const resetTimestamp = nowSeconds + 3; // 3 seconds in the future

      proxyFetchMock.mockResolvedValueOnce(
        new Response("Rate limited", {
          status: 429,
          headers: {
            "X-RateLimit-Reset": String(resetTimestamp),
          },
        }),
      );

      try {
        await client.get("/users/@me");
        expect.fail("Expected RateLimitError to be thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(RateLimitError);
        const rateLimitErr = err as RateLimitError;
        // Should be approximately 3 seconds (allow small variance due to timing)
        expect(rateLimitErr.retryAfter).toBeGreaterThanOrEqual(2);
        expect(rateLimitErr.retryAfter).toBeLessThanOrEqual(4);
        expect(rateLimitErr.status).toBe(429);
      }
    });

    it("prefers retry_after in body over X-RateLimit-Reset header", async () => {
      const nowSeconds = Math.floor(Date.now() / 1000);
      const resetTimestamp = nowSeconds + 10; // 10 seconds in the future

      proxyFetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            message: "Rate limited",
            retry_after: 2.5, // This should take priority
          }),
          {
            status: 429,
            headers: {
              "X-RateLimit-Reset": String(resetTimestamp),
            },
          },
        ),
      );

      try {
        await client.get("/users/@me");
        expect.fail("Expected RateLimitError to be thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(RateLimitError);
        const rateLimitErr = err as RateLimitError;
        expect(rateLimitErr.retryAfter).toBe(2.5); // Body value, not header
      }
    });

    it("prefers Retry-After header over X-RateLimit-Reset header", async () => {
      const nowSeconds = Math.floor(Date.now() / 1000);
      const resetTimestamp = nowSeconds + 10; // 10 seconds in the future

      proxyFetchMock.mockResolvedValueOnce(
        new Response("Rate limited", {
          status: 429,
          headers: {
            "Retry-After": "3",
            "X-RateLimit-Reset": String(resetTimestamp),
          },
        }),
      );

      try {
        await client.get("/users/@me");
        expect.fail("Expected RateLimitError to be thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(RateLimitError);
        const rateLimitErr = err as RateLimitError;
        expect(rateLimitErr.retryAfter).toBe(3); // Retry-After value, not X-RateLimit-Reset
      }
    });

    it("handles X-RateLimit-Reset in the past (uses 0 wait)", async () => {
      const nowSeconds = Math.floor(Date.now() / 1000);
      const resetTimestamp = nowSeconds - 5; // 5 seconds in the past

      proxyFetchMock.mockResolvedValueOnce(
        new Response("Rate limited", {
          status: 429,
          headers: {
            "X-RateLimit-Reset": String(resetTimestamp),
          },
        }),
      );

      try {
        await client.get("/users/@me");
        expect.fail("Expected RateLimitError to be thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(RateLimitError);
        const rateLimitErr = err as RateLimitError;
        expect(rateLimitErr.retryAfter).toBe(0); // Should be 0 for past timestamps
      }
    });
  });

  describe("multipart file upload", () => {
    it("converts files field to FormData with correct structure", async () => {
      const fileData = new Uint8Array([1, 2, 3, 4, 5]);
      await client.post("/channels/123/messages", {
        body: {
          content: "Here's a file",
          files: [{ data: fileData, name: "test.txt" }],
        },
      });

      const call = proxyFetchMock.mock.calls[0];
      const body = call[1]?.body as FormData;

      expect(body).toBeInstanceOf(FormData);
      expect(body.has("files[0]")).toBe(true);
      expect(body.has("payload_json")).toBe(true);
    });

    it("sets attachments array with correct file metadata", async () => {
      const fileData = new Uint8Array([1, 2, 3]);
      await client.post("/channels/123/messages", {
        body: {
          content: "File with description",
          files: [{ data: fileData, name: "document.pdf", description: "Important document" }],
        },
      });

      const call = proxyFetchMock.mock.calls[0];
      const body = call[1]?.body as FormData;
      const payloadJson = body.get("payload_json") as string;
      const payload = JSON.parse(payloadJson);

      expect(payload.attachments).toEqual([
        { id: 0, filename: "document.pdf", description: "Important document" },
      ]);
    });

    it("removes files field from payload_json", async () => {
      const fileData = new Blob(["test content"], { type: "text/plain" });
      await client.post("/channels/123/messages", {
        body: {
          content: "Message text",
          files: [{ data: fileData, name: "file.txt" }],
        },
      });

      const call = proxyFetchMock.mock.calls[0];
      const body = call[1]?.body as FormData;
      const payloadJson = body.get("payload_json") as string;
      const payload = JSON.parse(payloadJson);

      expect(payload.files).toBeUndefined();
      expect(payload.content).toBe("Message text");
    });

    it("handles Uint8Array file data", async () => {
      const uint8Data = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
      await client.post("/channels/123/messages", {
        body: {
          files: [{ data: uint8Data, name: "hello.txt" }],
        },
      });

      const call = proxyFetchMock.mock.calls[0];
      const body = call[1]?.body as FormData;
      const file = body.get("files[0]");

      expect(file).toBeInstanceOf(Blob);
    });

    it("handles Blob file data", async () => {
      const blobData = new Blob(["blob content"], { type: "text/plain" });
      await client.post("/channels/123/messages", {
        body: {
          files: [{ data: blobData, name: "blob.txt" }],
        },
      });

      const call = proxyFetchMock.mock.calls[0];
      const body = call[1]?.body as FormData;
      const file = body.get("files[0]");

      expect(file).toBeInstanceOf(Blob);
    });

    it("handles multiple files with correct indices", async () => {
      const file1 = new Uint8Array([1]);
      const file2 = new Uint8Array([2]);
      const file3 = new Blob(["three"]);

      await client.post("/channels/123/messages", {
        body: {
          files: [
            { data: file1, name: "first.txt" },
            { data: file2, name: "second.txt" },
            { data: file3, name: "third.txt" },
          ],
        },
      });

      const call = proxyFetchMock.mock.calls[0];
      const body = call[1]?.body as FormData;
      const payloadJson = body.get("payload_json") as string;
      const payload = JSON.parse(payloadJson);

      expect(payload.attachments).toHaveLength(3);
      expect(payload.attachments[0].id).toBe(0);
      expect(payload.attachments[1].id).toBe(1);
      expect(payload.attachments[2].id).toBe(2);
      expect(body.has("files[0]")).toBe(true);
      expect(body.has("files[1]")).toBe(true);
      expect(body.has("files[2]")).toBe(true);
    });

    it("removes Content-Type header to let FormData set boundary", async () => {
      const fileData = new Uint8Array([1, 2, 3]);
      await client.post("/channels/123/messages", {
        body: {
          files: [{ data: fileData, name: "test.bin" }],
        },
      });

      const call = proxyFetchMock.mock.calls[0];
      const headers = call[1]?.headers as Headers;

      expect(headers.get("Content-Type")).toBeNull();
    });
  });

  describe("error code preservation", () => {
    it("includes Discord error code in error object", async () => {
      proxyFetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: 50007,
            message: "Cannot send messages to this user",
          }),
          { status: 403 },
        ),
      );

      try {
        await client.post("/channels/123/messages", { body: { content: "test" } });
        expect.fail("Expected error to be thrown");
      } catch (err) {
        const error = err as Error & { code?: number };
        expect(error.code).toBe(50007);
      }
    });

    it("includes rawError field in error object", async () => {
      const errorBody = {
        code: 10008,
        message: "Unknown Message",
      };
      proxyFetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify(errorBody), { status: 404 }),
      );

      try {
        await client.get("/channels/123/messages/999");
        expect.fail("Expected error to be thrown");
      } catch (err) {
        const error = err as Error & { rawError?: unknown };
        expect(error.rawError).toEqual(errorBody);
      }
    });

    it("includes body field in error object", async () => {
      const errorBody = {
        code: 50001,
        message: "Missing Access",
      };
      proxyFetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify(errorBody), { status: 403 }),
      );

      try {
        await client.get("/guilds/123");
        expect.fail("Expected error to be thrown");
      } catch (err) {
        const error = err as Error & { body?: unknown };
        expect(error.body).toEqual(errorBody);
      }
    });

    it("handles invalid JSON error response without crashing", async () => {
      proxyFetchMock.mockResolvedValueOnce(new Response("Not JSON at all", { status: 500 }));

      try {
        await client.get("/users/@me");
        expect.fail("Expected error to be thrown");
      } catch (err) {
        const error = err as Error & { code?: number; body?: unknown; rawError?: unknown };
        // Should not have code/body/rawError when JSON parsing fails
        expect(error.code).toBeUndefined();
        expect(error.body).toBeUndefined();
        expect(error.rawError).toBeUndefined();
        expect(error.message).toContain("Discord API error (500)");
      }
    });

    it("handles error response with non-numeric code field", async () => {
      proxyFetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: "not-a-number",
            message: "Some error",
          }),
          { status: 400 },
        ),
      );

      try {
        await client.get("/users/@me");
        expect.fail("Expected error to be thrown");
      } catch (err) {
        const error = err as Error & { code?: number };
        // code should not be set if it's not a number
        expect(error.code).toBeUndefined();
      }
    });

    it("includes status code in error object", async () => {
      proxyFetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: 40001,
            message: "Unauthorized",
          }),
          { status: 401 },
        ),
      );

      try {
        await client.get("/users/@me");
        expect.fail("Expected error to be thrown");
      } catch (err) {
        const error = err as Error & { status?: number };
        expect(error.status).toBe(401);
      }
    });
  });

  describe("authorization header", () => {
    it("adds Bot prefix to tokens without prefix", async () => {
      const plainClient = new ProxiedRequestClient("plain-token", testProxyUrl);

      await plainClient.get("/users/@me");

      const call = proxyFetchMock.mock.calls[0];
      const headers = call[1]?.headers as Headers;
      // The client always adds "Bot" prefix via this.options.tokenHeader
      expect(headers.get("Authorization")).toBe("Bot plain-token");
    });

    it("strips existing Bot prefix to avoid duplication", async () => {
      const botClient = new ProxiedRequestClient("Bot my-bot-token", testProxyUrl);

      await botClient.get("/users/@me");

      const call = proxyFetchMock.mock.calls[0];
      const headers = call[1]?.headers as Headers;
      // The client should strip existing Bot prefix to avoid "Bot Bot token"
      expect(headers.get("Authorization")).toBe("Bot my-bot-token");
    });

    it("handles lowercase bot prefix", async () => {
      const botClient = new ProxiedRequestClient("bot my-bot-token", testProxyUrl);

      await botClient.get("/users/@me");

      const call = proxyFetchMock.mock.calls[0];
      const headers = call[1]?.headers as Headers;
      expect(headers.get("Authorization")).toBe("Bot my-bot-token");
    });

    it("handles Bot prefix with extra spaces", async () => {
      const botClient = new ProxiedRequestClient("Bot   my-bot-token", testProxyUrl);

      await botClient.get("/users/@me");

      const call = proxyFetchMock.mock.calls[0];
      const headers = call[1]?.headers as Headers;
      expect(headers.get("Authorization")).toBe("Bot my-bot-token");
    });
  });

  describe("timeout handling", () => {
    it("uses default timeout when timeout option is undefined", async () => {
      // Carbon's RequestClient defaults to 15000ms timeout
      // We can't directly test the timeout without a slow request, but we can verify
      // that the client doesn't crash with undefined timeout
      await client.get("/users/@me");
      expect(proxyFetchMock).toHaveBeenCalled();
    });

    it("respects timeout=0 as no timeout (allows long-running requests)", async () => {
      // Create a client with timeout=0 (no timeout)
      const noTimeoutClient = new ProxiedRequestClient(testToken, testProxyUrl);
      // Override the timeout option to 0
      (noTimeoutClient as unknown as { options: { timeout: number } }).options.timeout = 0;

      await noTimeoutClient.get("/users/@me");

      expect(proxyFetchMock).toHaveBeenCalled();
      // The request should succeed without timing out
    });
  });

  describe("boundary cases", () => {
    it("handles empty query object", async () => {
      await client.get("/users/@me", {});

      expect(proxyFetchMock).toHaveBeenCalledWith(
        "https://discord.com/api/v10/users/@me",
        expect.any(Object),
      );
    });

    it("handles undefined query parameter", async () => {
      await client.get("/users/@me", undefined);

      expect(proxyFetchMock).toHaveBeenCalledWith(
        "https://discord.com/api/v10/users/@me",
        expect.any(Object),
      );
    });

    it("handles special characters in query values", async () => {
      await client.get("/search", { q: "test?query=value&other=1" });

      const url = proxyFetchMock.mock.calls[0][0] as string;
      expect(url).toContain("q=test%3Fquery%3Dvalue%26other%3D1");
    });

    it("handles unicode characters in query values", async () => {
      await client.get("/search", { q: "你好世界" });

      const url = proxyFetchMock.mock.calls[0][0] as string;
      // Just verify the parameter is encoded (contains q= with some encoded value)
      expect(url).toMatch(/q=.+/);
      expect(url).toContain("search?");
    });

    it("handles numeric query values", async () => {
      await client.get("/channels/123", { limit: 100, offset: 0 });

      const url = proxyFetchMock.mock.calls[0][0] as string;
      expect(url).toContain("limit=100");
      expect(url).toContain("offset=0");
    });

    it("handles boolean query values", async () => {
      await client.get("/search", { active: true, archived: false });

      const url = proxyFetchMock.mock.calls[0][0] as string;
      expect(url).toContain("active=true");
      expect(url).toContain("archived=false");
    });
  });
});

describe("buildQueryString", () => {
  it("returns empty string for undefined query", () => {
    const result = buildQueryString(undefined);
    expect(result).toBe("");
  });

  it("returns empty string for empty query object", () => {
    const result = buildQueryString({});
    expect(result).toBe("");
  });

  it("builds query string with single parameter", () => {
    const result = buildQueryString({ limit: 10 });
    expect(result).toBe("?limit=10");
  });

  it("builds query string with multiple parameters", () => {
    const result = buildQueryString({ limit: 10, after: "100" });
    expect(result).toBe("?limit=10&after=100");
  });

  it("encodes special characters in values", () => {
    const result = buildQueryString({ q: "hello world" });
    expect(result).toBe("?q=hello%20world");
  });

  it("handles array parameters with comma-separated values", () => {
    const result = buildQueryString({ roles: ["1", "2", "3"] });
    expect(result).toBe("?roles=1,2,3");
  });

  it("handles empty array parameters", () => {
    const result = buildQueryString({ roles: [] });
    expect(result).toBe("");
  });

  it("handles mixed array and scalar parameters", () => {
    const result = buildQueryString({ q: "test", ids: ["1", "2"], limit: 10 });
    expect(result).toBe("?q=test&ids=1,2&limit=10");
  });
});

describe("createDiscordRestClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a ProxiedRequestClient when proxy is configured", () => {
    loadConfigMock.mockReturnValue({} as OpenClawConfig);
    resolveDiscordAccountMock.mockReturnValue({
      accountId: "default",
      token: "test-token",
      config: { proxy: "http://proxy.example.com:8080" },
    });

    const { rest } = createDiscordRestClient({});

    expect(rest).toBeInstanceOf(ProxiedRequestClient);
  });

  it("uses the provided rest client when given", () => {
    loadConfigMock.mockReturnValue({} as OpenClawConfig);
    resolveDiscordAccountMock.mockReturnValue({
      accountId: "default",
      token: "test-token",
      config: { proxy: "http://proxy.example.com:8080" },
    });

    const customRest = {} as ProxiedRequestClient;
    const { rest } = createDiscordRestClient({ rest: customRest });

    expect(rest).toBe(customRest);
  });

  it("creates a standard RequestClient when no proxy is configured", () => {
    loadConfigMock.mockReturnValue({} as OpenClawConfig);
    resolveDiscordAccountMock.mockReturnValue({
      accountId: "default",
      token: "test-token",
      config: {},
    });

    const { rest, token } = createDiscordRestClient({});

    expect(token).toBe("test-token");
    // When no proxy is configured, it returns a standard RequestClient
    expect(rest.constructor.name).toBe("RequestClient");
  });
});

describe("createDiscordClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns token, rest client, and retry runner", () => {
    loadConfigMock.mockReturnValue({} as OpenClawConfig);
    resolveDiscordAccountMock.mockReturnValue({
      accountId: "default",
      token: "test-token",
      config: {},
    });

    const { token, rest, request } = createDiscordClient({});

    expect(token).toBe("test-token");
    expect(rest).toBeDefined();
    expect(request).toBeDefined();
    expect(typeof request).toBe("function");
  });
});
