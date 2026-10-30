import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, onTestFinished } from "vitest";
import { createPluginRuntimeStore } from "../plugin-sdk/runtime-store.js";
import { getCompactionProvider, type CompactionProvider } from "./compaction-provider.js";
import { runPluginRegisterSyncInRegistry } from "./loader-module-runtime.js";
import { getPluginInstance } from "./plugin-instance-scope.js";
import { createOwnershipRecord } from "./registry-ownership.test-support.js";
import { createTestPluginRegistry as createTestRegistry } from "./registry-runtime.test-helpers.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "./runtime.js";
import { getPluginRuntimeGatewayRequestScope } from "./runtime/gateway-request-scope.js";

afterEach(resetPluginRuntimeStateForTest);

function makeProvider(
  id: string,
  summarize: CompactionProvider["summarize"] = async () => `summary-from-${id}`,
): CompactionProvider {
  return { id, label: id, summarize };
}

function registerProvider(
  builder: ReturnType<typeof createTestRegistry>,
  pluginId: string,
  provider: CompactionProvider,
  initialize?: () => void,
) {
  const record = createOwnershipRecord(pluginId, { source: `/plugins/${pluginId}/index.ts` });
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

it.each(["another registry", "shared duplicate", "distinct duplicate"])(
  "keeps the first provider and its runtime: %s",
  async (registration) => {
    const active = createTestRegistry();
    const { registry } = active;
    const store = createPluginRuntimeStore<string>("compaction runtime missing");
    const provider = makeProvider("shared", async () => {
      expect(getPluginRuntimeGatewayRequestScope()?.pluginRegistry).toBe(registry);
      return store.getRuntime();
    });
    registerProvider(active, "first-owner", provider, () => store.setRuntime("first runtime"));
    setActivePluginRegistry(registry);
    const other = registration === "another registry" ? createTestRegistry() : active;
    const second = registration === "distinct duplicate" ? makeProvider("shared") : provider;
    const otherOwner = registerProvider(other, "second-owner", second, () =>
      store.setRuntime("second runtime"),
    );
    expect(registry.compactionProviders).toEqual([{ provider, ownerPluginId: "first-owner" }]);
    expect(registry.compactionProviders[0]?.provider).toBe(provider);
    if (other === active) {
      expect(registry.diagnostics).toContainEqual(
        expect.objectContaining({
          level: "error",
          pluginId: "second-owner",
          message: "compaction provider already registered: shared (owner: first-owner)",
        }),
      );
    }
    const summarize = () => getCompactionProvider("shared")?.summarize({ messages: [] });
    await expect(summarize()).resolves.toBe("first runtime");
    await otherOwner.dispose();
    await expect(summarize()).resolves.toBe("first runtime");
  },
);
