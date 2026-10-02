import { afterEach, expect, it, vi } from "vitest";
import * as nativeModuleRequire from "../../../plugins/native-module-require.js";
import * as pluginModuleLoader from "../../../plugins/plugin-module-loader-cache.js";
import { applyLegacyDoctorMigrations } from "./legacy-config-compat.js";

const bindingRuntimePath = /legacy-config-binding-repair\.runtime\.[jt]s$/u;

afterEach(() => vi.restoreAllMocks());

it.each([
  { name: "explicit single agent", config: { agents: { entries: { main: {} } } } },
  {
    name: "disabled plugins",
    config: { agents: { entries: { main: {}, helper: {} } }, plugins: { enabled: false } },
  },
  {
    name: "malformed binding owner",
    config: {
      agents: { entries: { main: {}, helper: {} } },
      bindings: [{ agentId: "", match: { channel: "discord" } }],
    },
  },
])("migrates $name without loading the channel ownership runtime", ({ config }) => {
  const loadNative = nativeModuleRequire.tryNativeRequireModule;
  vi.spyOn(nativeModuleRequire, "tryNativeRequireModule").mockImplementation(
    (modulePath, options) => {
      if (bindingRuntimePath.test(modulePath)) {
        throw new Error("Loaded channel ownership runtime for an inapplicable repair");
      }
      return loadNative(modulePath, options);
    },
  );
  const load = pluginModuleLoader.getCachedPluginModuleLoader;
  vi.spyOn(pluginModuleLoader, "getCachedPluginModuleLoader").mockImplementation((options) => {
    if (bindingRuntimePath.test(options.modulePath)) {
      throw new Error("Loaded channel ownership runtime for an inapplicable repair");
    }
    return load(options);
  });
  const source = { ...config, gateway: { bind: "localhost" } };

  const migrated = applyLegacyDoctorMigrations(source, { sourceConfigBeforeMigrations: source });

  expect(migrated.next?.gateway).toMatchObject({ bind: "loopback" });
  expect(source.gateway.bind).toBe("localhost");
});

it.each(["unsupported", "failed"])("handles %s native binding repair loading", (outcome) => {
  const failure = new Error("Native binding repair dependency failed");
  const loadNative = nativeModuleRequire.tryNativeRequireModule;
  vi.spyOn(nativeModuleRequire, "tryNativeRequireModule").mockImplementation(
    (modulePath, options) => {
      if (!bindingRuntimePath.test(modulePath)) {
        return loadNative(modulePath, options);
      }
      if (outcome === "failed") {
        throw failure;
      }
      return { ok: false };
    },
  );
  const repair: typeof import("./legacy-config-binding-repair.runtime.js").repairUnownedChannelAccountBindings =
    ({ config }) => ({ config, changes: ["Used supported source transformation."] });
  const loadModule = pluginModuleLoader.getCachedPluginModuleLoader;
  vi.spyOn(pluginModuleLoader, "getCachedPluginModuleLoader").mockImplementation((options) => {
    if (!bindingRuntimePath.test(options.modulePath)) {
      return loadModule(options);
    }
    if (outcome === "failed") {
      throw new Error("Attempted a second binding repair module graph");
    }
    return () => ({ repairUnownedChannelAccountBindings: repair });
  });
  const source = { agents: { entries: { main: {}, ops: {} } } };
  const migrate = () =>
    applyLegacyDoctorMigrations(source, { sourceConfigBeforeMigrations: source });
  if (outcome === "failed") {
    expect(migrate).toThrow(failure);
  } else {
    expect(migrate().changes).toContain("Used supported source transformation.");
  }
});
