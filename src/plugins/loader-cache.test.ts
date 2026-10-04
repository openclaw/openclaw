/** Tests plugin registry cache-key sensitivity to activation-relevant config. */
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolvePluginRegistryLoadCacheKey } from "./loader-cache.js";

describe("resolvePluginRegistryLoadCacheKey", () => {
  it("keys canonical roster membership on both config views, not order or ordinary settings", () => {
    const config = { agents: { entries: { main: {}, _worker: {} } } };
    const keyFor = (runtime: OpenClawConfig = config, source: OpenClawConfig = runtime) =>
      resolvePluginRegistryLoadCacheKey({
        config: runtime,
        activationSourceConfig: source,
        env: {},
      });
    const key = keyFor();
    expect(keyFor({ agents: { entries: { _worker: {}, main: {} } } })).toBe(key);
    expect(
      keyFor({ agents: { entries: { main: { name: "Renamed display name" }, _worker: {} } } }),
    ).toBe(key);
    const removed = { agents: { entries: { main: {} } } };
    expect(keyFor(removed, config)).not.toBe(key);
    expect(keyFor(config, removed)).not.toBe(key);
    expect(resolvePluginRegistryLoadCacheKey({ config: {}, env: {} })).not.toBe(
      resolvePluginRegistryLoadCacheKey({ config: { agents: { entries: {} } }, env: {} }),
    );
  });

  it.each(["same config", "shared plugin config"] as const)(
    "separates absent, disabled, and enabled channel flags with %s",
    (mode) => {
      // channels.<id>.enabled steers activation on both sides, so each state needs its own registry.
      const plugins = {};
      const keyFor = (channel: Record<string, unknown>) => {
        const source = { plugins, channels: { telegram: channel } };
        return resolvePluginRegistryLoadCacheKey({
          config:
            mode === "same config"
              ? source
              : { plugins, channels: { telegram: { enabled: true } } },
          activationSourceConfig: source,
          env: {},
        });
      };
      const absent = keyFor({});
      const disabled = keyFor({ enabled: false });
      const enabled = keyFor({ enabled: true });

      expect(new Set([absent, disabled, enabled]).size).toBe(3);
    },
  );
});
