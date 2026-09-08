import { describe, expect, it } from "vitest";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import {
  gatewayRestartModuleLoaders,
  preloadGatewayRestartModules,
} from "./update-restart-preload.js";

describe("preloadGatewayRestartModules", () => {
  it("warms every loader so a later load never reaches the replaced install tree", async () => {
    const first = createLazyImportLoader(async () => ({ value: "first" }));
    const second = createLazyImportLoader(async () => ({ value: "second" }));
    expect(first.peek()).toBeUndefined();
    expect(second.peek()).toBeUndefined();

    await preloadGatewayRestartModules([first, second]);

    // A cached promise is the whole point: the post-swap call resolves from
    // memory instead of reading a hashed chunk the swap deleted.
    await expect(first.peek()).resolves.toEqual({ value: "first" });
    await expect(second.peek()).resolves.toEqual({ value: "second" });
  });

  it("still warms the remaining loaders when one fails to load", async () => {
    const broken = createLazyImportLoader(async () => {
      throw new Error("chunk unavailable");
    });
    const healthy = createLazyImportLoader(async () => ({ value: "healthy" }));

    // Preloading is best effort. It runs before the install swap, so throwing
    // here would abort an update that is otherwise fine.
    await expect(preloadGatewayRestartModules([broken, healthy])).resolves.toBeUndefined();

    await expect(healthy.peek()).resolves.toEqual({ value: "healthy" });
  });

  it("registers the restart path's lazy modules by default", () => {
    // Guards the wiring: an empty default registry would silently reintroduce
    // the post-swap ENOENT this preload exists to prevent.
    expect(gatewayRestartModuleLoaders.length).toBeGreaterThan(0);
  });
});
