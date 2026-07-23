import { describe, expect, it, vi } from "vitest";
import {
  buildSessionCatalogListCacheKey,
  SessionCatalogListBusyError,
  SessionCatalogListCoordinator,
} from "./session-catalog-list-coordinator.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function coordinator(now: () => number, maxConcurrentLoads = 2) {
  return new SessionCatalogListCoordinator<string>({
    freshTtlMs: 1_000,
    staleTtlMs: 10_000,
    maxCacheEntries: 2,
    maxConcurrentLoads,
    now,
  });
}

describe("SessionCatalogListCoordinator", () => {
  it("coalesces identical in-flight loads", async () => {
    const pending = deferred<string>();
    const load = vi.fn(() => pending.promise);
    const state = coordinator(() => 0);

    const first = state.run({ key: "same", load, cacheable: () => true });
    const second = state.run({ key: "same", load, cacheable: () => true });
    pending.resolve("catalog");

    await expect(Promise.all([first, second])).resolves.toEqual(["catalog", "catalog"]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("uses fresh cache and expires it at the configured TTL", async () => {
    let now = 0;
    const load = vi.fn(async () => `catalog-${now}`);
    const state = coordinator(() => now);

    await expect(state.run({ key: "same", load, cacheable: () => true })).resolves.toBe(
      "catalog-0",
    );
    now = 999;
    await expect(state.run({ key: "same", load, cacheable: () => true })).resolves.toBe(
      "catalog-0",
    );
    now = 1_000;
    await expect(state.run({ key: "same", load, cacheable: () => true })).resolves.toBe(
      "catalog-1000",
    );
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("serves stale cache only when admission is saturated", async () => {
    let now = 0;
    const state = coordinator(() => now, 1);
    await state.run({ key: "cached", load: async () => "old", cacheable: () => true });
    now = 2_000;

    const blocker = deferred<string>();
    const active = state.run({
      key: "other",
      load: () => blocker.promise,
      cacheable: () => true,
    });
    await expect(
      state.run({ key: "cached", load: async () => "new", cacheable: () => true }),
    ).resolves.toBe("old");
    await expect(
      state.run({ key: "uncached", load: async () => "new", cacheable: () => true }),
    ).rejects.toBeInstanceOf(SessionCatalogListBusyError);

    blocker.resolve("done");
    await active;
  });

  it("does not cache provider-error results", async () => {
    const load = vi.fn(async () => "error");
    const state = coordinator(() => 0);

    await state.run({ key: "same", load, cacheable: () => false });
    await state.run({ key: "same", load, cacheable: () => false });

    expect(load).toHaveBeenCalledTimes(2);
  });

  it("normalizes set-like request fields without merging different cursors", () => {
    const left = buildSessionCatalogListCacheKey({
      catalogIds: ["codex", "claude"],
      agentId: "main",
      hostIds: ["b", "a"],
      cursors: { b: "2", a: "1" },
    });
    const reordered = buildSessionCatalogListCacheKey({
      catalogIds: ["claude", "codex"],
      agentId: "main",
      hostIds: ["a", "b"],
      cursors: { a: "1", b: "2" },
    });
    const differentCursor = buildSessionCatalogListCacheKey({
      catalogIds: ["claude", "codex"],
      agentId: "main",
      hostIds: ["a", "b"],
      cursors: { a: "changed", b: "2" },
    });

    expect(reordered).toBe(left);
    expect(differentCursor).not.toBe(left);
  });
});
