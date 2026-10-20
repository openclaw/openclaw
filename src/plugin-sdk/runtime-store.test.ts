import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, test } from "vitest";
import { clearNamedPluginRuntimeStoresForTest } from "./runtime-store-registry.js";
import { createPluginRuntimeStore } from "./runtime-store.js";

const options = (pluginId: string) => ({ pluginId, errorMessage: "runtime not initialized" });
const namedStore = (pluginId: string) =>
  createPluginRuntimeStore<{ value: string }>(options(pluginId));
const legacyStore = () => createPluginRuntimeStore<{ value: string }>("legacy not initialized");
const customStore = () =>
  createPluginRuntimeStore<{ value: string }>({
    key: "custom-runtime-key",
    errorMessage: "custom runtime not initialized",
  });

describe("createPluginRuntimeStore", () => {
  test("shares runtime slots for the same plugin id", () => {
    const firstStore = namedStore("shared-plugin");
    const secondStore = namedStore("shared-plugin");

    firstStore.clearRuntime();
    firstStore.setRuntime({ value: "ok" });

    expect(secondStore.getRuntime()).toEqual({ value: "ok" });

    secondStore.clearRuntime();
    expect(firstStore.tryGetRuntime()).toBeNull();
  });

  test("keeps different plugin ids isolated", () => {
    const leftStore = namedStore("left-plugin");
    const rightStore = namedStore("right-plugin");

    leftStore.clearRuntime();
    rightStore.clearRuntime();
    leftStore.setRuntime({ value: "left" });

    expect(leftStore.getRuntime()).toEqual({ value: "left" });
    expect(rightStore.tryGetRuntime()).toBeNull();
  });

  test("keeps legacy string callers isolated per store", () => {
    const firstStore = legacyStore();
    const secondStore = legacyStore();

    firstStore.clearRuntime();
    firstStore.setRuntime({ value: "legacy" });

    expect(firstStore.getRuntime()).toEqual({ value: "legacy" });
    expect(secondStore.tryGetRuntime()).toBeNull();
  });

  test("still supports explicit custom store keys", () => {
    const firstStore = customStore();
    const secondStore = customStore();

    firstStore.clearRuntime();
    firstStore.setRuntime({ value: "custom" });

    expect(secondStore.getRuntime()).toEqual({ value: "custom" });
  });

  test("rejects empty plugin ids", () => {
    expect(() => namedStore("   ")).toThrow("pluginId must not be empty");
  });

  test("treats falsy runtime values as initialized", () => {
    const store = createPluginRuntimeStore<number>({
      key: "custom-falsy-runtime-key",
      errorMessage: "runtime not initialized",
    });

    store.clearRuntime();
    store.setRuntime(0);

    expect(store.getRuntime()).toBe(0);
  });

  test("shares runtime slots across duplicate module instances when plugin id matches", async () => {
    const firstModule = await importFreshModule<typeof import("./runtime-store.js")>(
      import.meta.url,
      "./runtime-store.js?scope=runtime-store-a",
    );
    const secondModule = await importFreshModule<typeof import("./runtime-store.js")>(
      import.meta.url,
      "./runtime-store.js?scope=runtime-store-b",
    );
    const firstStore = firstModule.createPluginRuntimeStore<{ value: string }>(
      options("duplicate-module-plugin"),
    );
    const secondStore = secondModule.createPluginRuntimeStore<{ value: string }>(
      options("duplicate-module-plugin"),
    );

    firstStore.clearRuntime();
    firstStore.setRuntime({ value: "shared" });

    expect(secondStore.getRuntime()).toEqual({ value: "shared" });
  });

  test("clears and detaches every named runtime slot without changing legacy stores", () => {
    const firstNamedStore = namedStore("first-reset-plugin");
    const secondNamedStore = namedStore("second-reset-plugin");
    const legacy = legacyStore();

    firstNamedStore.setRuntime({ value: "first" });
    secondNamedStore.setRuntime({ value: "second" });
    legacy.setRuntime({ value: "legacy" });

    clearNamedPluginRuntimeStoresForTest();

    expect(firstNamedStore.tryGetRuntime()).toBeNull();
    expect(secondNamedStore.tryGetRuntime()).toBeNull();
    expect(legacy.getRuntime()).toEqual({ value: "legacy" });

    const replacementStore = namedStore("first-reset-plugin");
    firstNamedStore.setRuntime({ value: "stale" });
    expect(replacementStore.tryGetRuntime()).toBeNull();
  });
});
