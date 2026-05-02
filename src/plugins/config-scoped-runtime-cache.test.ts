import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveConfigScopedRuntimeCacheValue,
  type ConfigScopedRuntimeCache,
} from "./config-scoped-runtime-cache.js";

describe("resolveConfigScopedRuntimeCacheValue", () => {
  it("caches values by config object and key", () => {
    const cache: ConfigScopedRuntimeCache<string[]> = new WeakMap();
    const config = {} as OpenClawConfig;
    const load = vi.fn(() => ["loaded"]);

    expect(resolveConfigScopedRuntimeCacheValue({ cache, config, key: "demo", load })).toEqual([
      "loaded",
    ]);
    expect(resolveConfigScopedRuntimeCacheValue({ cache, config, key: "demo", load })).toEqual([
      "loaded",
    ]);
    expect(load).toHaveBeenCalledOnce();
  });

  it("does not cache values without a config owner", () => {
    const cache: ConfigScopedRuntimeCache<string> = new WeakMap();
    const load = vi.fn(() => "loaded");

    expect(resolveConfigScopedRuntimeCacheValue({ cache, key: "demo", load })).toBe("loaded");
    expect(resolveConfigScopedRuntimeCacheValue({ cache, key: "demo", load })).toBe("loaded");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("caches undefined values by key", () => {
    const cache: ConfigScopedRuntimeCache<string | undefined> = new WeakMap();
    const config = {} as OpenClawConfig;
    const load = vi.fn(() => undefined);

    expect(resolveConfigScopedRuntimeCacheValue({ cache, config, key: "missing", load })).toBe(
      undefined,
    );
    expect(resolveConfigScopedRuntimeCacheValue({ cache, config, key: "missing", load })).toBe(
      undefined,
    );
    expect(load).toHaveBeenCalledOnce();
  });
});
