import { describe, expect, it } from "vitest";
import { fetchDiscordApplicationId } from "./probe.js";

function mockFetch(status: number, body?: unknown): typeof fetch {
  return (() =>
    Promise.resolve(
      new Response(JSON.stringify(body ?? {}), { status }),
    )) as unknown as typeof fetch;
}

function timeoutFetch(): typeof fetch {
  return (() =>
    Promise.reject(
      new DOMException("The operation was aborted", "AbortError"),
    )) as unknown as typeof fetch;
}

function networkErrorFetch(): typeof fetch {
  return (() => Promise.reject(new TypeError("fetch failed"))) as unknown as typeof fetch;
}

describe("fetchDiscordApplicationId", () => {
  it("returns the application id on success", async () => {
    const id = await fetchDiscordApplicationId(
      "valid.token.here",
      4000,
      mockFetch(200, { id: "123456" }),
    );
    expect(id).toBe("123456");
  });

  it("returns undefined for invalid token format", async () => {
    const id = await fetchDiscordApplicationId("", 4000, mockFetch(200, { id: "123" }));
    expect(id).toBeUndefined();
  });

  it("returns undefined on 401", async () => {
    const id = await fetchDiscordApplicationId("valid.token.here", 4000, mockFetch(401));
    expect(id).toBeUndefined();
  });

  it("returns undefined on 403", async () => {
    const id = await fetchDiscordApplicationId("valid.token.here", 4000, mockFetch(403));
    expect(id).toBeUndefined();
  });

  it("returns undefined on 400", async () => {
    const id = await fetchDiscordApplicationId("valid.token.here", 4000, mockFetch(400));
    expect(id).toBeUndefined();
  });

  it("returns undefined on 404", async () => {
    const id = await fetchDiscordApplicationId("valid.token.here", 4000, mockFetch(404));
    expect(id).toBeUndefined();
  });

  it("throws on 429", async () => {
    await expect(
      fetchDiscordApplicationId("valid.token.here", 4000, mockFetch(429)),
    ).rejects.toThrow("Discord application ID fetch failed (429)");
  });

  it("throws on 500", async () => {
    await expect(
      fetchDiscordApplicationId("valid.token.here", 4000, mockFetch(500)),
    ).rejects.toThrow("Discord application ID fetch failed (500)");
  });

  it("throws on 503", async () => {
    await expect(
      fetchDiscordApplicationId("valid.token.here", 4000, mockFetch(503)),
    ).rejects.toThrow("Discord application ID fetch failed (503)");
  });

  it("throws on network error", async () => {
    await expect(
      fetchDiscordApplicationId("valid.token.here", 4000, networkErrorFetch()),
    ).rejects.toThrow("fetch failed");
  });

  it("throws on timeout", async () => {
    await expect(
      fetchDiscordApplicationId("valid.token.here", 4000, timeoutFetch()),
    ).rejects.toThrow("aborted");
  });
});
