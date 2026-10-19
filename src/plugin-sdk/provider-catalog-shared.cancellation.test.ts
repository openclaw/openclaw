import { afterEach, describe, expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  captureProviderCatalogExpiries,
  recordLiveCatalogExpiry,
  withProviderCatalogExpiry,
} from "../plugins/provider-catalog-expiry.js";
import {
  clearLiveCatalogCacheForTests,
  getCachedLiveCatalogValue,
} from "./provider-catalog-shared.js";

describe("live catalog consumer cancellation", () => {
  afterEach(() => clearLiveCatalogCacheForTests());

  it("delivers a shared failure to active consumers", async () => {
    const pending = createDeferred<string>();
    const error = new Error("catalog failed");
    let loads = 0;
    const load = () => {
      loads += 1;
      return pending.promise;
    };
    const signals = [
      new AbortController().signal,
      new AbortController().signal,
      new AbortController().signal,
    ];
    const values = signals.map((signal) =>
      getCachedLiveCatalogValue({ keyParts: ["shared failure"], load, signal }),
    );
    const joined = Promise.allSettled(values);
    pending.reject(error);
    expect(await joined).toEqual(
      Array.from({ length: 3 }, () => ({ status: "rejected", reason: error })),
    );
    expect(loads).toBe(1);
  });

  it.each([new Error("consumer closed"), { source: "consumer closed" }])(
    "cancels independently with the original reason %s",
    async (reason) => {
      const pending = createDeferred<string>();
      const controller = new AbortController();
      const params = { keyParts: ["independent"], load: () => pending.promise };
      const survivor = getCachedLiveCatalogValue(params);
      const consumer = getCachedLiveCatalogValue({ ...params, signal: controller.signal });
      const joined = Promise.allSettled([survivor, consumer]);
      controller.abort(reason);
      await expect(consumer).rejects.toBe(reason);
      pending.resolve("catalog");
      const results = await joined;
      expect(results[0]).toEqual({ status: "fulfilled", value: "catalog" });
      expect(results[1]).toEqual({ status: "rejected", reason });
    },
  );

  it("records shared completion expiry in each consumer's context", async () => {
    const pending = createDeferred<string>();
    const read = (expiry: number) =>
      captureProviderCatalogExpiries(() =>
        withProviderCatalogExpiry(
          () => {
            recordLiveCatalogExpiry(expiry);
            return getCachedLiveCatalogValue({
              keyParts: ["expiry"],
              load: () => pending.promise,
              signal: new AbortController().signal,
              ttlMs: 500,
              now: () => 0,
            });
          },
          () => ["provider"],
        ),
      );
    const first = read(100);
    const second = read(2_000);
    pending.resolve("catalog");
    const results = await Promise.all([first, second]);
    expect(results.map((result) => result.providerExpiries.get("provider"))).toEqual([100, 500]);
  });
});
