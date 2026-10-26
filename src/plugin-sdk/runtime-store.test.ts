import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { expect, test } from "vitest";
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

test.each([
  ["plugin id", () => namedStore("shared-plugin")],
  ["explicit key", customStore],
] as const)("shares runtime slots by %s", (_name, create) => {
  const first = create();
  const second = create();
  first.clearRuntime();
  first.setRuntime({ value: "ok" });
  expect(second.getRuntime()).toEqual({ value: "ok" });
  second.clearRuntime();
  expect(first.tryGetRuntime()).toBeNull();
});

test.each([
  ["different plugin ids", () => namedStore("left-plugin"), () => namedStore("right-plugin")],
  ["legacy callers", legacyStore, legacyStore],
] as const)("isolates %s", (_name, createLeft, createRight) => {
  const left = createLeft();
  const right = createRight();
  left.clearRuntime();
  right.clearRuntime();
  left.setRuntime({ value: "left" });
  expect(left.getRuntime()).toEqual({ value: "left" });
  expect(right.tryGetRuntime()).toBeNull();
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

test("shares slots across duplicate module instances", async () => {
  const load = (suffix: string) =>
    importFreshModule<typeof import("./runtime-store.js")>(
      import.meta.url,
      `./runtime-store.js?scope=runtime-store-${suffix}`,
    );
  const firstModule = await load("a");
  const secondModule = await load("b");
  const first = firstModule.createPluginRuntimeStore<{ value: string }>(
    options("duplicate-module-plugin"),
  );
  const second = secondModule.createPluginRuntimeStore<{ value: string }>(
    options("duplicate-module-plugin"),
  );
  first.clearRuntime();
  first.setRuntime({ value: "shared" });
  expect(second.getRuntime()).toEqual({ value: "shared" });
});

test("clears and detaches every named slot without changing legacy stores", () => {
  const first = namedStore("first-reset-plugin");
  const second = namedStore("second-reset-plugin");
  const legacy = legacyStore();
  first.setRuntime({ value: "first" });
  second.setRuntime({ value: "second" });
  legacy.setRuntime({ value: "legacy" });
  clearNamedPluginRuntimeStoresForTest();
  expect([first.tryGetRuntime(), second.tryGetRuntime(), legacy.getRuntime()]).toEqual([
    null,
    null,
    { value: "legacy" },
  ]);
  const replacement = namedStore("first-reset-plugin");
  first.setRuntime({ value: "stale" });
  expect(replacement.tryGetRuntime()).toBeNull();
});
