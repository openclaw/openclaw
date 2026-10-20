import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createLazyPromise, createLazyPromiseLoader, getOrCreatePromise } from "./lazy-promise.js";

function cachedLoad(options: Parameters<typeof getOrCreatePromise<string, string>>[3]) {
  const cache = new Map<string, Promise<string>>();
  const load = (key: string, create: () => Promise<string>) =>
    getOrCreatePromise(cache, key, create, options);
  return { cache, load };
}

const recoveringLoad = () =>
  vi
    .fn<() => Promise<string>>()
    .mockRejectedValueOnce(new Error("transient"))
    .mockResolvedValue("recovered");

describe("lazy promises", () => {
  it("evicts only rejected loads when rejection caching is disabled", async () => {
    const { load } = cachedLoad({ cacheRejections: false });
    const create = recoveringLoad();

    await expect(load("a", create)).rejects.toThrow("transient");
    await expect(load("a", create)).resolves.toBe("recovered");
    await expect(load("a", create)).resolves.toBe("recovered");
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("evicts settled in-flight work without deleting a replacement", async () => {
    const { cache, load } = cachedLoad({ evictOnSettled: true });
    const deferred = createDeferred<string>();
    const first = load("a", () => deferred.promise);
    const replacement = Promise.resolve("replacement");
    cache.set("a", replacement);

    deferred.resolve("first");
    await expect(first).resolves.toBe("first");
    expect(cache.get("a")).toBe(replacement);

    await expect(load("b", async () => "settled")).resolves.toBe("settled");
    expect(cache.has("b")).toBe(false);
  });

  it("does not let a stale rejection delete a replacement", async () => {
    const { cache, load } = cachedLoad({ cacheRejections: false });
    const deferred = createDeferred<string>();
    const first = load("a", () => deferred.promise);
    const replacement = Promise.resolve("replacement");
    cache.set("a", replacement);

    deferred.reject(new Error("stale"));
    await expect(first).rejects.toThrow("stale");
    expect(cache.get("a")).toBe(replacement);
  });
  it("returns a reusable single-flight loader", async () => {
    let calls = 0;
    const load = createLazyPromise(async () => `loaded-${++calls}`);

    await expect(Promise.all([load(), load()])).resolves.toEqual(["loaded-1", "loaded-1"]);
    await expect(load()).resolves.toBe("loaded-1");
    expect(calls).toBe(1);
  });
  it("evicts rejected loads by default so retries can recover", async () => {
    const create = recoveringLoad();
    const loader = createLazyPromiseLoader(create);

    await expect(loader.load()).rejects.toThrow("transient");
    await expect(loader.load()).resolves.toBe("recovered");
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("clears cached values", async () => {
    let calls = 0;
    const loader = createLazyPromiseLoader(() => `loaded-${++calls}`);

    expect(loader.peek()).toBeUndefined();
    await expect(loader.load()).resolves.toBe("loaded-1");
    await expect(loader.peek()).resolves.toBe("loaded-1");
    loader.clear();
    expect(loader.peek()).toBeUndefined();
    await expect(loader.load()).resolves.toBe("loaded-2");
  });
});
