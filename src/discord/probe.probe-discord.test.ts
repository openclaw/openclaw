import { describe, expect, it, vi } from "vitest";
import { probeDiscord } from "./probe.js";

const VALID_TOKEN = "test-token.timestamp.hmac";

function mockFetch(status: number, body: unknown, opts?: { jsonThrows?: boolean }): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: opts?.jsonThrows
      ? vi.fn().mockRejectedValue(new SyntaxError("Unexpected token"))
      : vi.fn().mockResolvedValue(body),
  } as unknown as Response);
}

function networkErrorFetch(): typeof fetch {
  return vi.fn().mockRejectedValue(new TypeError("fetch failed"));
}

describe("probeDiscord", () => {
  it("returns ok with bot info on successful 200 response", async () => {
    const fetcher = mockFetch(200, { id: "123456", username: "test-bot" });
    const result = await probeDiscord(VALID_TOKEN, 5000, { fetcher });

    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.bot).toEqual({ id: "123456", username: "test-bot" });
    expect(result.error).toBeNull();
  });

  it("returns error with status on HTTP 401", async () => {
    const fetcher = mockFetch(401, { message: "Unauthorized" });
    const result = await probeDiscord(VALID_TOKEN, 5000, { fetcher });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
    expect(result.error).toContain("401");
  });

  it("returns error with status on HTTP 403", async () => {
    const fetcher = mockFetch(403, { message: "Forbidden" });
    const result = await probeDiscord(VALID_TOKEN, 5000, { fetcher });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(403);
    expect(result.error).toContain("403");
  });

  it("preserves HTTP status when res.json() throws after a 200 response", async () => {
    const fetcher = mockFetch(200, null, { jsonThrows: true });
    const result = await probeDiscord(VALID_TOKEN, 5000, { fetcher });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(200);
    expect(result.error).toContain("Unexpected token");
  });

  it("reports network errors with null status", async () => {
    const fetcher = networkErrorFetch();
    const result = await probeDiscord(VALID_TOKEN, 5000, { fetcher });

    expect(result.ok).toBe(false);
    expect(result.status).toBeNull();
    expect(result.error).toContain("fetch failed");
  });

  it("returns missing token error for empty input", async () => {
    const result = await probeDiscord("", 5000);

    expect(result.ok).toBe(false);
    expect(result.error).toBe("missing token");
  });

  it("includes elapsedMs in all results", async () => {
    const fetcher = mockFetch(200, { id: "1", username: "bot" });
    const result = await probeDiscord(VALID_TOKEN, 5000, { fetcher });

    expect(typeof result.elapsedMs).toBe("number");
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("handles missing id and username in response", async () => {
    const fetcher = mockFetch(200, {});
    const result = await probeDiscord(VALID_TOKEN, 5000, { fetcher });

    expect(result.ok).toBe(true);
    expect(result.bot).toEqual({ id: null, username: null });
  });
});
