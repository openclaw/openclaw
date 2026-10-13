/** Tests plugin loader cache state keys, invalidation, and reset behavior. */
import { AsyncLocalStorage } from "node:async_hooks";
import { describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { PluginLoaderCacheState } from "./loader-cache-state.js";

describe("PluginLoaderCacheState", () => {
  it("reuses the completed registry cache for concurrent async callers", async () => {
    const cache = new PluginLoaderCacheState<object>(2);
    const entered = createDeferredCore();
    const completed = createDeferredCore<object>();
    const register = vi.fn(async () => {
      entered.resolve();
      const registry = await completed.promise;
      cache.set("demo", registry);
      return registry;
    });
    const load = async () => cache.get("demo") ?? register();
    const first = cache.loadAsync("demo", load);
    const second = cache.loadAsync("demo", load);
    await entered.promise;
    const registry = {};
    completed.resolve(registry);
    await expect(first).resolves.toBe(registry);
    await expect(second).resolves.toBe(registry);
    expect(register).toHaveBeenCalledOnce();
  });

  it.each([true, false])(
    "retains strict and permissive caller policies (strict first: %s)",
    async (strictFirst) => {
      const cache = new PluginLoaderCacheState<string>(2);
      const load = async (strict: boolean) => {
        const registry = cache.get("demo") ?? "registry with load errors";
        if (strict) {
          throw new Error("strict load failure");
        }
        cache.set("demo", registry);
        return registry;
      };
      const first = cache.loadAsync("demo", () => load(strictFirst));
      const second = cache.loadAsync("demo", () => load(!strictFirst));
      const outcomes = await Promise.allSettled([first, second]);
      expect(outcomes[strictFirst ? 0 : 1]).toMatchObject({
        status: "rejected",
        reason: expect.objectContaining({ message: "strict load failure" }),
      });
      expect(outcomes[strictFirst ? 1 : 0]).toEqual({
        status: "fulfilled",
        value: "registry with load errors",
      });
    },
  );

  it("rejects recursive async loading without poisoning the next load", async () => {
    const cache = new PluginLoaderCacheState<string>(2);
    await expect(
      cache.loadAsync("demo", async () => cache.loadAsync("demo", async () => "nested")),
    ).rejects.toThrow("plugin load reentry detected");
    await expect(cache.loadAsync("demo", async () => "recovered")).resolves.toBe("recovered");
  });

  it("releases a failed async scope before a captured callback loads again", async () => {
    const cache = new PluginLoaderCacheState<string>(2);
    let resume: ReturnType<typeof AsyncLocalStorage.snapshot>;
    await expect(
      cache.loadAsync("demo", async () => {
        resume = AsyncLocalStorage.snapshot();
        throw new Error("registration failed");
      }),
    ).rejects.toThrow("registration failed");
    await expect(resume!(() => cache.loadAsync("demo", async () => "recovered"))).resolves.toBe(
      "recovered",
    );
  });

  it("bounds open-allowlist warning suppression by loader cache capacity", () => {
    const cache = new PluginLoaderCacheState<string>(2);

    cache.recordOpenAllowlistWarning("first");
    cache.recordOpenAllowlistWarning("second");
    cache.recordOpenAllowlistWarning("third");

    expect(cache.hasOpenAllowlistWarning("first")).toBe(false);
    expect(cache.hasOpenAllowlistWarning("second")).toBe(true);
    expect(cache.hasOpenAllowlistWarning("third")).toBe(true);
  });

  it("clears registry, in-flight, and warning state together", () => {
    const cache = new PluginLoaderCacheState<string>(2);

    cache.set("demo", "registry");
    cache.beginLoad("demo");
    cache.recordOpenAllowlistWarning("demo-warning");

    cache.clear();

    expect(cache.get("demo")).toBeUndefined();
    expect(cache.isLoadInFlight("demo")).toBe(false);
    expect(cache.hasOpenAllowlistWarning("demo-warning")).toBe(false);
  });

  it("clears cached registries without dropping in-flight load guards", () => {
    const cache = new PluginLoaderCacheState<string>(2);

    cache.set("demo", "registry");
    cache.beginLoad("demo");
    cache.recordOpenAllowlistWarning("demo-warning");

    cache.clearCachedRegistries();

    expect(cache.get("demo")).toBeUndefined();
    expect(cache.isLoadInFlight("demo")).toBe(true);
    expect(cache.hasOpenAllowlistWarning("demo-warning")).toBe(false);
  });
});
