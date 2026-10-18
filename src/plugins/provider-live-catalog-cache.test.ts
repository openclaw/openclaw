import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import {
  clearLiveCatalogCacheForTests,
  getCachedLiveCatalogValue,
} from "./provider-live-catalog-cache.js";

beforeEach(clearLiveCatalogCacheForTests);
afterEach(clearLiveCatalogCacheForTests);

describe("live catalog cache lifecycle", () => {
  it("preserves warm catalogs across restarts and reloads, then releases them on close", async () => {
    const load = vi.fn(async () => ["fixture/model"]);
    const read = () => getCachedLiveCatalogValue({ keyParts: ["lifecycle"], load });
    const original = await read();

    for (const event of ["restart", "plugin-registry", "shared-state"] as const) {
      await drainGlobalSingletonLifecycleState(event);
      expect(await read()).toBe(original);
    }
    expect(load).toHaveBeenCalledOnce();

    await drainGlobalSingletonLifecycleState("close");
    expect(await read()).toEqual(original);
    expect(load).toHaveBeenCalledTimes(2);

    await drainGlobalSingletonLifecycleState("close");
    await read();
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("lets an admitted load finish without repopulating a closed cache", async () => {
    const completion = createDeferred<string[]>();
    const keyParts = ["pending-lifecycle"];
    const pending = getCachedLiveCatalogValue({ keyParts, load: () => completion.promise });

    await drainGlobalSingletonLifecycleState("close");
    completion.resolve(["fixture/old"]);
    await expect(pending).resolves.toEqual(["fixture/old"]);

    const load = vi.fn(async () => ["fixture/current"]);
    await expect(getCachedLiveCatalogValue({ keyParts, load })).resolves.toEqual([
      "fixture/current",
    ]);
    expect(load).toHaveBeenCalledOnce();
  });
});
