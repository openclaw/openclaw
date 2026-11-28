/** Verifies the optional provider store contract and file-shaped runtimes as backends. */
import { expect, it, vi } from "vitest";
import { createLegacyBackendProviderRuntime } from "./memory-backend-legacy.js";
import { settleMemoryProviderOpen } from "./memory-provider-open.js";
import type { MemoryProviderHandle, MemoryStoreRequest } from "./memory-provider-runtime-types.js";
import type { MemoryCallerContext } from "./memory-provider-types.js";
import type {
  MemoryPluginRuntime,
  RegisteredMemorySearchManager,
} from "./registry-contribution-types.js";

const context: MemoryCallerContext = {
  authority: { kind: "host", operation: "store-test" },
  assertCurrent() {},
};

function writable(store?: MemoryProviderHandle["store"], advertise = true) {
  const handle: MemoryProviderHandle = {
    capabilities: {
      sources: ["memory"],
      pagination: false,
      candidates: [],
      projectFilter: false,
      ...(advertise ? { store: true } : {}),
    },
    search: async () => ({ hits: [] }),
    get: async () => ({ status: "not_found" }),
    health: async () => ({ status: "ready" }),
    close: async () => {},
    ...(store ? { store } : {}),
  };
  return handle;
}

const settle = (handle: MemoryProviderHandle) =>
  settleMemoryProviderOpen({ provider: handle }, "notes", context, context, {});

it("passes store through a bound lease and checks the returned reference", async () => {
  const store = vi.fn(async (request: MemoryStoreRequest) => ({
    status: "stored" as const,
    reference: { providerId: "notes", id: request.text },
  }));
  const { provider } = await settle(writable(store));
  expect(provider!.capabilities.store).toBe(true);
  await expect(provider!.store!({ text: "remember", origin: "tool" })).resolves.toEqual({
    status: "stored",
    reference: { providerId: "notes", id: "remember" },
  });
  expect(store).toHaveBeenCalledWith({ text: "remember", origin: "tool" });

  store.mockResolvedValueOnce({ status: "stored", reference: { providerId: "other", id: "x" } });
  await expect(provider!.store!({ text: "x" })).rejects.toThrow("different provider");
  await expect(provider!.store!({ text: "   " })).rejects.toThrow("non-empty text");
  await expect(provider!.store!({ text: "x".repeat(64 * 1024 + 1) })).rejects.toThrow("exceeds");
  expect(store).toHaveBeenCalledTimes(2);
});

it.each([
  [
    "store without the capability",
    writable(async () => ({ status: "rejected", reason: "no" }), false),
  ],
  ["the capability without store", writable(undefined, true)],
])("rejects a provider that advertises %s", async (_label, handle) => {
  await expect(settle(handle)).rejects.toThrow("matching candidates and store");
});

it("serves a file-shaped runtime as a backend through the legacy adapter", async () => {
  const manager = {
    search: vi.fn(async () => [
      {
        path: "memory/notes.md",
        startLine: 1,
        endLine: 2,
        score: 0.5,
        snippet: "legacy fact",
        source: "memory" as const,
      },
    ]),
    readFile: vi.fn(async () => ({ text: "legacy fact body", path: "memory/notes.md" })),
    status: () => ({ backend: "builtin" as const, files: 1, chunks: 1 }),
  } as unknown as RegisteredMemorySearchManager;
  const getMemorySearchManager = vi.fn(async () => ({ manager }));
  const runtime = {
    getMemorySearchManager,
    resolveMemoryBackendConfig: () => ({ backend: "builtin" as const }),
  } as unknown as MemoryPluginRuntime;
  const backend = createLegacyBackendProviderRuntime("memory-core", runtime);
  const opened = await backend.open({ cfg: {}, agentId: "main", context, purpose: "status" });
  expect(getMemorySearchManager).toHaveBeenCalledWith({
    cfg: {},
    agentId: "main",
    purpose: "status",
  });
  const page = await opened.provider!.search({ query: "fact" });
  expect(page.hits[0]).toMatchObject({
    excerpt: "legacy fact",
    reference: { providerId: "memory-core", id: "memory/notes.md" },
  });
  expect("store" in opened.provider!).toBe(false);
});

it("registers a file-shaped runtime as a legacy backend instead of dropping it", async () => {
  const { createTestPluginRegistry } = await import("./registry-runtime.test-helpers.js");
  const { createPluginRecord } = await import("./loader-records.js");
  const fixture = createTestPluginRegistry();
  const record = createPluginRecord({
    id: "memory-core",
    source: "fixture",
    origin: "config",
    enabled: true,
    configSchema: false,
  });
  record.kind = "memory";
  record.memoryBackend = true;
  fixture.registry.plugins.push(record);
  const runtime = {
    getMemorySearchManager: async () => ({ manager: null }),
    resolveMemoryBackendConfig: () => ({ backend: "builtin" as const }),
  } as MemoryPluginRuntime;
  fixture
    .createApi(record, { config: {}, registrationMode: "memory-backend" })
    .registerMemoryCapability({ runtime });
  expect(fixture.registry.memoryBackends).toMatchObject([
    {
      pluginId: "memory-core",
      adapter: "legacy",
      instanceOwner: expect.objectContaining({ getMemorySearchManager: expect.any(Function) }),
    },
  ]);
  expect(fixture.registry.memoryCapabilities).toEqual([]);
});
