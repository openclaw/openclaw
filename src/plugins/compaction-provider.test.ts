/** Covers canonical plugin compaction provider registration and runtime lookup. */
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, onTestFinished } from "vitest";
import { createPluginRuntimeStore } from "../plugin-sdk/runtime-store.js";
import { getCompactionProvider, type CompactionProvider } from "./compaction-provider.js";
import { runPluginRegisterSyncInRegistry } from "./loader-module-runtime.js";
import { createPluginRecord } from "./loader-records.js";
import { getPluginInstance } from "./plugin-instance-scope.js";
import { createPluginRegistry } from "./registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "./runtime.js";
import { getPluginRuntimeGatewayRequestScope } from "./runtime/gateway-request-scope.js";
import type { PluginRuntime } from "./runtime/types.js";

afterEach(() => {
  resetPluginRuntimeStateForTest();
});

function createTestRegistry() {
  return createPluginRegistry({
    logger: {
      info() {},
      warn() {},
      error() {},
      debug() {},
    },
    runtime: {} as PluginRuntime,
    activateGlobalSideEffects: false,
  });
}

function createRecord(id: string) {
  return createPluginRecord({
    id,
    source: `/plugins/${id}/index.ts`,
    origin: "global",
    enabled: true,
    configSchema: false,
  });
}

function makeProvider(id: string, label?: string): CompactionProvider {
  return {
    id,
    label: label ?? id,
    async summarize() {
      return `summary-from-${id}`;
    },
  };
}

function registerProvider(
  builder: ReturnType<typeof createTestRegistry>,
  pluginId: string,
  provider: CompactionProvider,
  initialize?: () => void,
) {
  const record = createRecord(pluginId);
  const api = builder.createApi(record, { config: {} });
  runPluginRegisterSyncInRegistry(
    (registeredApi) => {
      initialize?.();
      registeredApi.registerCompactionProvider(provider);
    },
    api,
    builder.registry,
    pluginId,
  );
  builder.registry.plugins.push(record);
  const instance = expectDefined(getPluginInstance(record), "compaction provider instance");
  onTestFinished(async () => {
    await instance.dispose();
  });
  return instance;
}

describe("compaction provider registry", () => {
  it("reads providers registered through the plugin API from the active registry", async () => {
    const pluginRegistry = createTestRegistry();
    const provider = makeProvider("owned");
    const owner = registerProvider(pluginRegistry, "owner", provider);
    setActivePluginRegistry(pluginRegistry.registry);

    expect(pluginRegistry.registry.compactionProviders).toEqual([
      { provider, ownerPluginId: "owner" },
    ]);
    const resolved = getCompactionProvider("owned");
    await expect(resolved?.summarize({ messages: [] })).resolves.toBe("summary-from-owned");
    await owner.dispose();
    expect(() => resolved?.summarize({ messages: [] })).toThrow(/reloaded|disabled|retiring/);
  });

  it("keeps the first provider when another plugin registers the same id", () => {
    const pluginRegistry = createTestRegistry();
    const first = makeProvider("shared", "first");
    const second = makeProvider("shared", "second");
    registerProvider(pluginRegistry, "first-owner", first);
    registerProvider(pluginRegistry, "second-owner", second);

    expect(pluginRegistry.registry.compactionProviders).toEqual([
      { provider: first, ownerPluginId: "first-owner" },
    ]);
    expect(pluginRegistry.registry.diagnostics).toContainEqual(
      expect.objectContaining({
        level: "error",
        pluginId: "second-owner",
        message: "compaction provider already registered: shared (owner: first-owner)",
      }),
    );
  });

  it.each(["another registry", "rejected duplicate"])(
    "keeps the selected provider owner when a shared descriptor is adopted by %s",
    async (registration) => {
      const active = createTestRegistry();
      const store = createPluginRuntimeStore<string>("compaction runtime missing");
      const provider: CompactionProvider = {
        id: "shared",
        label: "Shared",
        async summarize() {
          expect(getPluginRuntimeGatewayRequestScope()?.pluginRegistry).toBe(active.registry);
          return store.getRuntime();
        },
      };
      registerProvider(active, "first-owner", provider, () => store.setRuntime("first runtime"));
      setActivePluginRegistry(active.registry);
      const other = registration === "another registry" ? createTestRegistry() : active;
      const otherOwner = registerProvider(other, "second-owner", provider, () =>
        store.setRuntime("second runtime"),
      );
      expect(active.registry.compactionProviders[0]?.provider).toBe(provider);
      await expect(getCompactionProvider("shared")?.summarize({ messages: [] })).resolves.toBe(
        "first runtime",
      );
      await otherOwner.dispose();
      await expect(getCompactionProvider("shared")?.summarize({ messages: [] })).resolves.toBe(
        "first runtime",
      );
    },
  );
});
