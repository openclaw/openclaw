import { describe, expect, it, vi } from "vitest";

describe("web_search shared cache", () => {
  it("keeps cache entries module-local instead of exposing them on a global symbol", async () => {
    vi.resetModules();
    delete (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.web-search.cache")];

    const module = await import("./web-search-provider-common.js");
    const cacheKey = "query:test";
    module.writeCachedSearchPayload(cacheKey, { ok: true }, 60_000);

    expect(module.readCachedSearchPayload(cacheKey)).toEqual({ ok: true, cached: true });
    expect(
      (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.web-search.cache")],
    ).toBeUndefined();
  });
});

describe("resolveSearchProxy", () => {
  it("returns undefined when proxy config is missing or blank", async () => {
    vi.resetModules();
    const module = await import("./web-search-provider-common.js");
    expect(module.resolveSearchProxy(undefined)).toBeUndefined();
    expect(module.resolveSearchProxy({})).toBeUndefined();
    expect(module.resolveSearchProxy({ proxy: "   " })).toBeUndefined();
  });

  it("reuses the same fetch wrapper for the same proxy URL and rotates on change", async () => {
    vi.resetModules();
    const module = await import("./web-search-provider-common.js");
    const first = module.resolveSearchProxy({ proxy: "http://proxy-a.test:8080" });
    const second = module.resolveSearchProxy({ proxy: "http://proxy-a.test:8080" });
    const third = module.resolveSearchProxy({ proxy: "http://proxy-b.test:9090" });

    expect(first).toBe(second);
    expect(third).not.toBe(first);
  });

  it("throws a descriptive error for invalid proxy URLs", async () => {
    vi.resetModules();
    const module = await import("./web-search-provider-common.js");
    expect(() => module.resolveSearchProxy({ proxy: "\x00not-a-url" })).toThrow(
      /Invalid proxy URL in tools\.web\.search\.proxy/,
    );
  });
});
