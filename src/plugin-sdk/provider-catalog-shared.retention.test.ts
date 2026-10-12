import { AsyncLocalStorage } from "node:async_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { queryObjects } from "node:v8";
import { afterEach, describe, expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  clearLiveCatalogCacheForTests,
  getCachedLiveCatalogValue,
} from "./provider-catalog-shared.js";

describe("live catalog consumer retention", () => {
  afterEach(() => clearLiveCatalogCacheForTests());

  it("releases canceled joiners' reasons and contexts while a shared load stays pending", async () => {
    const pending = createDeferred<string>();
    const storage = new AsyncLocalStorage<{ marker: object }>();
    let loads = 0;
    let acquisition: AbortSignal | undefined;
    const params = {
      keyParts: ["retention"],
      load: (signal?: AbortSignal) => {
        loads += 1;
        acquisition = signal;
        return pending.promise;
      },
    };
    const survivor = getCachedLiveCatalogValue(params);
    async function cancelJoiner(mode: "reason" | "context") {
      const marker = { mode };
      const reference = new WeakRef(marker);
      const controller = new AbortController();
      const reason = mode === "reason" ? marker : new Error("consumer closed");
      const call = () => getCachedLiveCatalogValue({ ...params, signal: controller.signal });
      const consumer = mode === "context" ? storage.run({ marker }, call) : call();
      const joined = consumer.then(
        () => {
          throw new Error("canceled consumer resolved");
        },
        (error: unknown) => {
          if (error !== reason) {
            throw new Error("cancellation reason changed");
          }
        },
      );
      controller.abort(reason);
      await joined;
      return reference;
    }
    try {
      const context = await cancelJoiner("context");
      const reason = await cancelJoiner("reason");
      const control = new WeakRef({ unowned: true });
      // End the factory job before collection; dereferencing earlier would retain the markers.
      await nextTurn();
      queryObjects(WeakRef);
      expect(control.deref()).toBeUndefined();
      expect(reason.deref()).toBeUndefined();
      expect(context.deref()).toBeUndefined();
      expect(loads).toBe(1);
      expect(acquisition?.aborted).toBe(false);
    } finally {
      pending.resolve("catalog");
      await survivor;
      storage.disable();
    }
  });
});
