import { expect, it, vi } from "vitest";
import { createPluginRecord } from "./loader-records.js";
import type { MemoryProviderHandle } from "./memory-provider-runtime-types.js";
import type { MemoryBackendAccess, MemoryProviderOpenParams } from "./memory-provider-types.js";
import { getActiveMemoryProviderCore } from "./memory-runtime.js";
import { createTestPluginRegistry } from "./registry-runtime.test-helpers.js";
import { createPluginRegistryOwner } from "./runtime.js";
import { withPluginRuntimeRegistryScope } from "./runtime/gateway-request-scope.js";

function memoryRecord(id: string) {
  const record = createPluginRecord({
    id,
    source: "fixture",
    origin: "config",
    enabled: true,
    configSchema: false,
  });
  record.kind = "memory";
  return record;
}

function recordProvider(providerId: string, close = vi.fn(async () => {})) {
  const reference = { providerId, id: `${providerId}:1` };
  const handle: MemoryProviderHandle = {
    capabilities: { sources: ["memory"], pagination: false, candidates: [], projectFilter: false },
    search: async () => ({ hits: [{ reference, excerpt: `from ${providerId}` }] }),
    get: async () => ({ status: "ok", reference, text: providerId }),
    health: async () => ({ status: "ready" }),
    close,
  };
  return { handle, close, reference };
}

it("lets the slot owner open a passive backend under its own caller authority", async () => {
  const fixture = createTestPluginRegistry();
  const owner = memoryRecord("memory-fusion");
  owner.memorySlotSelected = true;
  const backend = memoryRecord("memory-store");
  backend.memoryBackend = true;
  fixture.registry.plugins.push(owner, backend);

  const backendProvider = recordProvider("memory-store");
  const backendOpen = vi.fn(async (_params: MemoryProviderOpenParams) => ({
    provider: backendProvider.handle,
  }));
  const backendApi = fixture.createApi(backend, {
    config: {},
    registrationMode: "memory-backend",
  });
  expect(backendApi.registrationMode).toBe("memory-backend");
  backendApi.registerMemoryCapability({ providerRuntime: { open: backendOpen } });
  // Only the provider registrar is live; every other surface stays inert.
  backendApi.registerTool({ name: "store_tool" } as never);
  backendApi.on("agent_end", () => {});
  backendApi.registerService({ id: "store-worker", start() {} });
  backendApi.registerCli(() => {}, { commands: ["store"] });

  let access: MemoryBackendAccess | undefined;
  const ownerProvider = recordProvider("memory-fusion");
  fixture.createApi(owner, { config: {} }).registerMemoryCapability({
    providerRuntime: {
      open: async (params) => {
        access = params.backends;
        // The owner cannot rewrite the authority a backend receives, in place or by replacement.
        Object.assign(params.context.authority, { operation: "forged" });
        params.context.authority = { kind: "operator", scopes: ["operator.admin"] };
        return { provider: ownerProvider.handle };
      },
    },
  });

  expect(fixture.registry.memoryBackends.map(({ pluginId }) => pluginId)).toEqual(["memory-store"]);
  expect(fixture.registry.memoryCapabilities.map(({ pluginId }) => pluginId)).toEqual([
    "memory-fusion",
  ]);
  for (const key of ["tools", "typedHooks", "services", "cliRegistrars"] as const) {
    expect(fixture.registry[key].filter(({ pluginId }) => pluginId === "memory-store")).toEqual([]);
  }

  const registryOwner = createPluginRegistryOwner(fixture.registry);
  try {
    const authority: { kind: "host"; operation: string } = {
      kind: "host",
      operation: "backend-test",
    };
    const forged: MemoryBackendAccess = {
      list: () => [{ id: "forged" }],
      open: async () => ({ provider: null }),
    };
    const acquired = await withPluginRuntimeRegistryScope(fixture.registry, () =>
      getActiveMemoryProviderCore({
        cfg: {},
        agentId: "main",
        purpose: "status",
        context: { authority, assertCurrent() {} },
        backends: forged,
      }),
    );
    expect(acquired.providerId).toBe("memory-fusion");
    expect(access).toBeDefined();
    expect(access).not.toBe(forged);
    expect(access!.list()).toEqual([{ id: "memory-store", name: "memory-store" }]);
    await expect(access!.open("memory-missing")).resolves.toMatchObject({ provider: null });

    const opened = await access!.open("memory-store");
    expect(opened).toMatchObject({ providerId: "memory-store", adapter: "native" });
    const openParams = backendOpen.mock.calls[0]![0];
    expect(openParams).toMatchObject({ agentId: "main", purpose: "status" });
    expect(openParams.context.authority).toEqual({ kind: "host", operation: "backend-test" });
    expect(Object.isFrozen(openParams.context.authority)).toBe(true);
    expect(openParams.backends).toBeUndefined();
    await expect(opened.provider!.search({ query: "q" })).resolves.toMatchObject({
      hits: [{ reference: backendProvider.reference }],
    });
    // Backend references keep the backend's own provider id; the owner cannot pass them off.
    await expect(
      opened.provider!.get({ reference: { providerId: "memory-fusion", id: "x" } }),
    ).rejects.toThrow("different provider");

    await acquired.provider!.close();
    expect(ownerProvider.close).toHaveBeenCalledOnce();
    expect(backendProvider.close).toHaveBeenCalledOnce();
    await expect(access!.open("memory-store")).rejects.toThrow("memory backend access ended");
  } finally {
    await registryOwner.close();
  }
});

it("withholds backend access from an owner when no backend is loaded", async () => {
  const fixture = createTestPluginRegistry();
  const owner = memoryRecord("memory-fusion");
  owner.memorySlotSelected = true;
  fixture.registry.plugins.push(owner);
  const open = vi.fn(async (_params: MemoryProviderOpenParams) => ({
    provider: recordProvider("memory-fusion").handle,
  }));
  fixture.createApi(owner, { config: {} }).registerMemoryCapability({ providerRuntime: { open } });
  const registryOwner = createPluginRegistryOwner(fixture.registry);
  try {
    const acquired = await withPluginRuntimeRegistryScope(fixture.registry, () =>
      getActiveMemoryProviderCore({
        cfg: {},
        agentId: "main",
        context: { authority: { kind: "host", operation: "backend-test" }, assertCurrent() {} },
      }),
    );
    expect(open.mock.calls[0]![0].backends).toBeUndefined();
    await acquired.provider?.close();
  } finally {
    await registryOwner.close();
  }
});

it("keeps operator scopes the owner appends out of a backend's authority", async () => {
  const fixture = createTestPluginRegistry();
  const owner = memoryRecord("memory-fusion");
  owner.memorySlotSelected = true;
  const backend = memoryRecord("memory-store");
  backend.memoryBackend = true;
  fixture.registry.plugins.push(owner, backend);
  const backendOpen = vi.fn(async (_params: MemoryProviderOpenParams) => ({
    provider: recordProvider("memory-store").handle,
  }));
  fixture
    .createApi(backend, { config: {}, registrationMode: "memory-backend" })
    .registerMemoryCapability({ providerRuntime: { open: backendOpen } });
  fixture.createApi(owner, { config: {} }).registerMemoryCapability({
    providerRuntime: {
      open: async (params) => {
        const { authority } = params.context;
        if (authority.kind === "operator") {
          (authority.scopes as string[]).push("operator.admin");
        }
        const opened = await params.backends!.open("memory-store");
        await opened.provider?.close();
        return { provider: recordProvider("memory-fusion").handle };
      },
    },
  });
  const registryOwner = createPluginRegistryOwner(fixture.registry);
  try {
    const acquired = await withPluginRuntimeRegistryScope(fixture.registry, () =>
      getActiveMemoryProviderCore({
        cfg: {},
        agentId: "main",
        context: { authority: { kind: "operator", scopes: ["operator.read"] }, assertCurrent() {} },
      }),
    );
    expect(backendOpen.mock.calls[0]![0].context.authority).toEqual({
      kind: "operator",
      scopes: ["operator.read"],
    });
    await acquired.provider?.close();
  } finally {
    await registryOwner.close();
  }
});
