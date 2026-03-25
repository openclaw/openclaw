import { describe, expect, it, vi } from "vitest";
import { fetchPackageVersions } from "./npm-registry-versions.js";

function mockFetch(response: { status?: number; ok?: boolean; body?: unknown }): typeof fetch {
  return vi.fn(async () => ({
    status: response.status ?? 200,
    ok: response.ok ?? true,
    json: async () => response.body,
  })) as unknown as typeof fetch;
}

describe("fetchPackageVersions", () => {
  it("parses versions with engines from registry response", async () => {
    const fetchFn = mockFetch({
      body: {
        versions: {
          "2026.3.10": { engines: { openclaw: ">=2026.3.10" } },
          "2026.3.12": { engines: { openclaw: ">=2026.3.10" } },
          "2026.3.14": {},
        },
      },
    });

    const result = await fetchPackageVersions({
      packageName: "@openclaw/memory-core",
      fetchFn,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.versions).toHaveLength(3);
    expect(result.versions).toContainEqual({
      version: "2026.3.10",
      engines: { openclaw: ">=2026.3.10" },
    });
    expect(result.versions).toContainEqual({ version: "2026.3.14" });

    // Verify URL encoding for scoped package
    expect(fetchFn).toHaveBeenCalledWith(
      "https://registry.npmjs.org/@openclaw%2Fmemory-core",
      expect.objectContaining({
        headers: { Accept: "application/vnd.npm.install-v1+json" },
      }),
    );
  });

  it("returns error on 404", async () => {
    const fetchFn = mockFetch({ status: 404, ok: false });
    const result = await fetchPackageVersions({
      packageName: "nonexistent-package",
      fetchFn,
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toContain("not found");
  });

  it("returns error on network failure", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    const result = await fetchPackageVersions({
      packageName: "some-package",
      fetchFn,
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toContain("ECONNREFUSED");
  });

  it("returns error on timeout", async () => {
    const fetchFn = vi.fn(async () => {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    }) as unknown as typeof fetch;

    const result = await fetchPackageVersions({
      packageName: "some-package",
      fetchFn,
      timeoutMs: 100,
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toContain("timed out");
  });

  it("returns empty versions when response has no versions object", async () => {
    const fetchFn = mockFetch({ body: { name: "some-package" } });
    const result = await fetchPackageVersions({
      packageName: "some-package",
      fetchFn,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.versions).toEqual([]);
  });

  it("returns error for empty package name", async () => {
    const result = await fetchPackageVersions({ packageName: "" });
    expect(result.ok).toBe(false);
  });
});
