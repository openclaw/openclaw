import { afterEach, expect, it, vi } from "vitest";
import { createPluginRecord } from "./loader-records.js";
import type { prepareMemoryRuntimeReload } from "./memory-runtime.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";

const state = vi.hoisted(() => ({
  rotated: false,
  imports: 0,
  closeMemory: vi.fn<ReturnType<typeof prepareMemoryRuntimeReload>["close"]>(async () => ({
    errors: [],
  })),
}));

vi.mock("../shared/lazy-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../shared/lazy-runtime.js")>();
  return {
    ...actual,
    createLazyRuntimeModule: <T>(importer: () => Promise<T>) =>
      actual.createLazyRuntimeModule(async () => {
        state.imports += 1;
        if (state.rotated) {
          throw new Error("synthetic installed runtime artifact was removed");
        }
        return await importer();
      }),
  };
});
vi.mock("./host-hook-cleanup.js", () => ({
  createPluginHostRegistryRetirement: () => async () => ({ cleanupCount: 0, failures: [] }),
}));
vi.mock("./memory-runtime.js", () => ({
  prepareMemoryRuntimeReload: () => ({ close: state.closeMemory, commit() {} }),
}));

// This contract starts at cold module acquisition, before any test setup can warm it.
vi.resetModules();
const {
  createPluginRegistryOwner,
  prepareActivePluginRegistryShutdown,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} = await import("./runtime.js");

afterEach(() => {
  state.rotated = false;
  resetPluginRuntimeStateForTest();
});

it("retains the exact memory shutdown loader before installed artifacts rotate", async () => {
  const registry = createEmptyPluginRegistry();
  const record = createPluginRecord({
    id: "memory-preload",
    source: "fixture",
    origin: "config",
    enabled: true,
    configSchema: false,
  });
  registry.plugins.push(record);
  registry.memoryCapabilities.push({
    pluginId: record.id,
    capability: {
      runtime: {
        getMemorySearchManager: async () => ({ manager: null }),
        resolveMemoryBackendConfig: () => ({ backend: "builtin" }),
      },
    },
  });
  setActivePluginRegistry(registry);
  const owner = createPluginRegistryOwner(registry);
  await prepareActivePluginRegistryShutdown();
  const preparedImports = state.imports;
  expect(preparedImports).toBeGreaterThan(0);
  // Reject importer entry itself, even if Vitest has an incidental module cached.
  state.rotated = true;
  await expect(owner.close()).resolves.toEqual({ memoryErrors: [] });
  expect(state.closeMemory).toHaveBeenCalledOnce();
  expect(state.imports).toBe(preparedImports);
});
