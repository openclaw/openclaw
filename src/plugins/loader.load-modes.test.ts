import { afterAll, afterEach, expect, it, vi } from "vitest";
import { clearRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { resetPluginStateStoreForTests } from "../plugin-state/plugin-state-store.js";
import { loadPluginRegistryHandle } from "./loader.js";
import {
  cleanupPluginLoaderFixturesForTest,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
} from "./loader.test-fixtures.js";

afterEach(() => {
  vi.restoreAllMocks();
  resetPluginStateStoreForTests();
  resetPluginLoaderTestStateForTest();
  clearRuntimeConfigSnapshot();
});

afterAll(() => {
  cleanupPluginLoaderFixturesForTest();
});

it.each(["validate", "full"] as const)(
  "keeps validation and full registry caches separate when %s loads first",
  (firstMode) => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "cached-load-mode",
      registration: 'api.registerProvider({ id: "mode-provider", label: "Mode", auth: [] });',
    });
    const options = {
      config: {
        plugins: {
          allow: [plugin.id],
          load: { paths: [plugin.file] },
          slots: { memory: "none" },
        },
      },
    };
    const first = loadPluginRegistryHandle({ ...options, mode: firstMode });
    const second = loadPluginRegistryHandle({
      ...options,
      mode: firstMode === "validate" ? "full" : "validate",
    });
    const full = firstMode === "full" ? first : second;
    const validation = firstMode === "validate" ? first : second;

    expect(full.providers.map(({ provider }) => provider.id)).toEqual(["mode-provider"]);
    expect(validation.plugins).toContainEqual(
      expect.objectContaining({ id: plugin.id, status: "loaded" }),
    );
    expect(validation.providers).toEqual([]);
    expect(loadPluginRegistryHandle(options)).toBe(full);
    expect(loadPluginRegistryHandle({ ...options, mode: "full" })).toBe(full);
    expect(loadPluginRegistryHandle({ ...options, mode: "validate" })).toBe(validation);
  },
);
