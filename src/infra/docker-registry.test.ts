import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchGhcrToken,
  fetchRegistryTags,
  queryRegistryVersions,
} from "./docker-registry.js";

describe("fetchGhcrToken", () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns a token on success", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ token: "test-token-123" }),
    } as Response);

    const result = await fetchGhcrToken({
      timeoutMs: 1000,
      fetchFn: mockFetch,
    });

    expect(result.token).toBe("test-token-123");
    expect(result.error).toBeUndefined();
  });

  it("returns error on HTTP failure", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({}),
    } as Response);

    const result = await fetchGhcrToken({
      timeoutMs: 1000,
      fetchFn: mockFetch,
    });

    expect(result.token).toBeNull();
    expect(result.error).toContain("401");
  });

  it("returns error on network failure", async () => {
    mockFetch.mockRejectedValue(new Error("network error"));

    const result = await fetchGhcrToken({
      timeoutMs: 1000,
      fetchFn: mockFetch,
    });

    expect(result.token).toBeNull();
    expect(result.error).toContain("network error");
  });
});

describe("fetchRegistryTags", () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns tags from the registry", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ tags: ["1.0.0", "1.1.0", "latest"] }),
    } as Response);

    const result = await fetchRegistryTags({
      token: "test-token",
      timeoutMs: 1000,
      fetchFn: mockFetch,
    });

    expect(result.tags).toEqual(["1.0.0", "1.1.0", "latest"]);
    expect(result.error).toBeUndefined();
  });

  it("sends authorization header", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ tags: [] }),
    } as Response);

    await fetchRegistryTags({
      token: "bearer-token",
      timeoutMs: 1000,
      fetchFn: mockFetch,
    });

    const callArgs = mockFetch.mock.calls[0];
    expect(callArgs[1].headers.Authorization).toBe("Bearer bearer-token");
  });

  it("returns empty tags on error", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({}),
    } as Response);

    const result = await fetchRegistryTags({
      token: "test-token",
      timeoutMs: 1000,
      fetchFn: mockFetch,
    });

    expect(result.tags).toEqual([]);
    expect(result.error).toContain("403");
  });
});

describe("queryRegistryVersions", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  let callCount: number;

  beforeEach(() => {
    callCount = 0;
    mockFetch = vi.fn(async (url: string) => {
      callCount++;
      // First call: token exchange
      if (callCount === 1) {
        return {
          ok: true,
          json: async () => ({ token: "test-token" }),
        } as Response;
      }
      // Second call: tags list
      return {
        ok: true,
        json: async () => ({
          tags: [
            "1.0.0",
            "1.1.0",
            "1.2.0-beta.1",
            "2.0.0",
            "latest",
            "main",
            "1.0.0-alpha.1",
            "1.1.0-rc.1",
          ],
        }),
      } as Response;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("filters and sorts stable versions", async () => {
    const result = await queryRegistryVersions({
      channel: "stable",
      timeoutMs: 1000,
      fetchFn: mockFetch,
    });

    expect(result.latestVersion).toBe("2.0.0");
    expect(result.latestTag).toBe("2.0.0");
    expect(result.tags.map((t) => t.version)).toEqual(["2.0.0", "1.1.0", "1.0.0"]);
    expect(result.error).toBeUndefined();
  });

  it("includes pre-release versions for beta channel", async () => {
    const result = await queryRegistryVersions({
      channel: "beta",
      timeoutMs: 1000,
      fetchFn: mockFetch,
    });

    expect(result.latestVersion).toBe("2.0.0");
    // All semver tags should be included
    expect(result.tags.length).toBeGreaterThanOrEqual(5);
  });

  it("returns error when token exchange fails", async () => {
    mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
    } as Response);

    const result = await queryRegistryVersions({
      channel: "stable",
      timeoutMs: 1000,
      fetchFn: mockFetch,
    });

    expect(result.latestVersion).toBeNull();
    expect(result.error).toBeDefined();
  });

  it("handles empty tag list", async () => {
    callCount = 0;
    mockFetch = vi.fn(async () => {
      callCount++;
      if (callCount === 1) {
        return { ok: true, json: async () => ({ token: "t" }) } as Response;
      }
      return { ok: true, json: async () => ({ tags: [] }) } as Response;
    });

    const result = await queryRegistryVersions({
      channel: "stable",
      timeoutMs: 1000,
      fetchFn: mockFetch,
    });

    expect(result.latestVersion).toBeNull();
    expect(result.tags).toEqual([]);
  });
});
