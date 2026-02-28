import { describe, expect, it, vi } from "vitest";
import { fetchDiscordApplicationId } from "./probe.js";

const LARGE_APP_ID = "1477179610322964541"; // 19 digits, exceeds MAX_SAFE_INTEGER
const SMALL_APP_ID = "123456789012345678"; // 18 digits, safe

describe("fetchDiscordApplicationId", () => {
  it("handles large application ID as string from API", async () => {
    const mockFetcher = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: LARGE_APP_ID, flags: 0 }),
    });
    const result = await fetchDiscordApplicationId("test-token", 1000, mockFetcher);
    expect(result).toBe(LARGE_APP_ID);
    expect(typeof result).toBe("string");
  });

  it("handles large application ID as number from API (bug scenario)", async () => {
    const largeNumberAsString = "1477179610322964541";
    const mockFetcher = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: largeNumberAsString, flags: 0 }),
    });
    const result = await fetchDiscordApplicationId("test-token", 1000, mockFetcher);
    expect(result).toBe(largeNumberAsString);
    expect(typeof result).toBe("string");
  });

  it("converts numeric ID to string to prevent potential precision issues", async () => {
    const mockFetcher = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: 12345678901234, flags: 0 }),
    });
    const result = await fetchDiscordApplicationId("test-token", 1000, mockFetcher);
    expect(result).toBe("12345678901234");
    expect(typeof result).toBe("string");
  });

  it("handles small application ID", async () => {
    const mockFetcher = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: SMALL_APP_ID, flags: 0 }),
    });
    const result = await fetchDiscordApplicationId("test-token", 1000, mockFetcher);
    expect(result).toBe(SMALL_APP_ID);
  });

  it("returns undefined when API returns non-ok status", async () => {
    const mockFetcher = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
    });
    const result = await fetchDiscordApplicationId("invalid-token", 1000, mockFetcher);
    expect(result).toBeUndefined();
  });

  it("returns undefined when API throws", async () => {
    const mockFetcher = vi.fn().mockRejectedValue(new Error("network error"));
    const result = await fetchDiscordApplicationId("test-token", 1000, mockFetcher);
    expect(result).toBeUndefined();
  });
});
