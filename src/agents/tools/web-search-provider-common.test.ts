import { describe, expect, it, vi } from "vitest";

describe("web_search shared cache", () => {
  it("does not expose the cache through a global Symbol.for key", async () => {
    vi.resetModules();
    const before = (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.web-search.cache")];
    delete (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.web-search.cache")];

    const module = await import("./web-search-provider-common.js");
    module.SEARCH_CACHE.set("query:test", {
      value: { ok: true },
      insertedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    });

    expect((globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.web-search.cache")]).toBeUndefined();

    if (before !== undefined) {
      (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.web-search.cache")] = before;
    }
  });
});
