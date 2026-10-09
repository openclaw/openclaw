import { expect, it, vi } from "vitest";
import { createPluginRecord } from "./loader-records.js";
import type { MemoryProviderHandle } from "./memory-provider-types.js";
import { getActiveMemoryProviderCore } from "./memory-runtime.js";
import { createTestPluginRegistry } from "./registry-runtime.test-helpers.js";
import { createPluginRegistryOwner } from "./runtime.js";
import { withPluginRuntimeRegistryScope } from "./runtime/gateway-request-scope.js";

it("acquires a registered record-only provider and fences its lease when the registry closes", async () => {
  const registry = createTestPluginRegistry();
  const record = createPluginRecord({
    id: "record-memory",
    source: "fixture",
    origin: "config",
    enabled: true,
    configSchema: false,
  });
  record.kind = "memory";
  record.memorySlotSelected = true;
  registry.registry.plugins.push(record);
  const closeAll = vi.fn(async () => {});
  const reference = { providerId: record.id, id: "claim:123", revision: "r1" };
  const raw: MemoryProviderHandle = {
    capabilities: {
      sources: ["memory"],
      pagination: false,
      candidates: [],
      projectFilter: false,
    },
    search: async () => ({ hits: [{ reference, excerpt: "A record-only memory" }] }),
    get: async () => ({ status: "ok", reference, text: "The complete record" }),
    health: async () => ({ status: "ready" }),
    close: vi.fn(async () => {}),
  };
  registry.createApi(record, { config: {} }).registerMemoryCapability({
    providerRuntime: {
      open: async () => ({ provider: raw }),
      closeAllMemorySearchManagers: closeAll,
    },
  });
  const owner = createPluginRegistryOwner(registry.registry);
  try {
    const acquired = await withPluginRuntimeRegistryScope(registry.registry, () =>
      getActiveMemoryProviderCore({
        cfg: {},
        agentId: "main",
        context: {
          authority: { kind: "host", operation: "registration-test" },
          assertCurrent() {},
        },
      }),
    );
    expect(acquired.providerId).toBe(record.id);
    expect(acquired.provider).not.toBeNull();
    const provider = acquired.provider!;
    const hits = await provider.search({ query: "memory" });
    expect(hits.hits[0]?.reference).toEqual(reference);
    await expect(provider.get({ reference })).resolves.toMatchObject({
      status: "ok",
      text: "The complete record",
    });
    await owner.close();
    expect(closeAll).toHaveBeenCalledOnce();
    await expect(provider.search({ query: "after retirement" })).rejects.toThrow();
  } finally {
    await owner.close();
  }
});
