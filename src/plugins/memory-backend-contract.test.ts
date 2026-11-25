/** Edge contracts of memory backends and provider store found by mutation testing. */
import { describe, expect, it, vi } from "vitest";
import { createPluginLoadLoopState } from "./loader-load-loop-state.js";
import { createPluginRecord } from "./loader-records.js";
import { createLegacyBackendProviderRuntime } from "./memory-backend-legacy.js";
import { isMemoryBackendRequested, slotOwnerRequestsMemoryBackends } from "./memory-backend.js";
import { createMemoryBackendAccess, settleMemoryProviderOpen } from "./memory-provider-open.js";
import type { MemoryProviderHandle } from "./memory-provider-runtime-types.js";
import type { MemoryCallerContext } from "./memory-provider-types.js";
import type { MemoryPluginRuntime } from "./registry-contribution-types.js";
import { createTestPluginRegistry } from "./registry-runtime.test-helpers.js";

const context: MemoryCallerContext = {
  authority: { kind: "host", operation: "contract" },
  assertCurrent() {},
};

function handle(
  overrides: Record<string, unknown> = {},
  capabilities: Record<string, unknown> = {},
) {
  return {
    capabilities: {
      sources: ["memory"],
      pagination: false,
      candidates: [],
      projectFilter: false,
      ...capabilities,
    },
    search: async () => ({ hits: [] }),
    get: async () => ({ status: "not_found" }),
    health: async () => ({ status: "ready" }),
    close: vi.fn(async () => {}),
    ...overrides,
  } as unknown as MemoryProviderHandle;
}

const settle = (provider: MemoryProviderHandle, options?: { readOnly?: boolean }) =>
  settleMemoryProviderOpen({ provider }, "notes", context, context, {}, undefined, options);

const stored = { status: "stored" as const, reference: { providerId: "notes", id: "1" } };

describe("store input and result validation", () => {
  it("rejects non-string tags and a missing request, accepts exactly 64 KiB", async () => {
    const store = vi.fn(async () => stored);
    const { provider } = await settle(handle({ store }, { store: true }));
    await expect(provider!.store!({ text: "x", tags: ["ok", 5 as never] })).rejects.toThrow(
      "memory store tags must be strings",
    );
    await expect(provider!.store!(undefined as never)).rejects.toThrow("non-empty text");
    await expect(provider!.store!({ text: "x".repeat(64 * 1024), tags: ["a"] })).resolves.toEqual(
      stored,
    );
    expect(store).toHaveBeenCalledTimes(1);
  });

  it("passes valid rejections through and refuses malformed results", async () => {
    const store = vi.fn();
    const { provider } = await settle(handle({ store }, { store: true }));
    store.mockResolvedValueOnce({ status: "rejected", reason: "quota" });
    await expect(provider!.store!({ text: "x" })).resolves.toEqual({
      status: "rejected",
      reason: "quota",
    });
    for (const bad of [{ status: "rejected" }, { status: "maybe", reason: "?" }]) {
      store.mockResolvedValueOnce(bad);
      await expect(provider!.store!({ text: "x" })).rejects.toThrow(
        "memory provider returned an invalid store result",
      );
    }
  });

  it("works without bind options and advertises store only when present", async () => {
    const writable = await settle(handle({ store: async () => stored }, { store: true }));
    expect(writable.provider!.capabilities).toEqual({
      sources: ["memory"],
      pagination: false,
      candidates: [],
      projectFilter: false,
      store: true,
    });
    await expect(writable.provider!.store!({ text: "x" })).resolves.toEqual(stored);
    const readOnly = await settle(handle());
    expect("store" in readOnly.provider!.capabilities).toBe(false);
  });
});

describe("open-time handle validation", () => {
  it.each(["search", "get", "health", "close"])("rejects a handle missing %s", async (method) => {
    await expect(settle(handle({ [method]: undefined }))).rejects.toThrow(
      "memory provider must implement",
    );
  });

  it.each([
    ["pagination", { pagination: "no" }],
    ["candidate kind", { candidates: ["everything"] }],
    ["project filter", { projectFilter: 1 }],
    ["store flag", { store: "yes" }],
  ])("rejects an invalid %s capability", async (_label, capabilities) => {
    await expect(settle(handle({}, capabilities))).rejects.toThrow(
      "memory provider must implement",
    );
  });

  it("accepts both candidate kinds", async () => {
    const candidates = async () => ({ hits: [] });
    await expect(
      settle(handle({ candidates }, { candidates: ["trigger", "project"] })),
    ).resolves.toMatchObject({ provider: expect.anything() });
  });
});

describe("backend access", () => {
  const backendRuntime = (provider: () => Promise<{ provider: MemoryProviderHandle }>) => ({
    pluginId: "store",
    providerRuntime: { open: provider },
  });

  it("makes backend leases read-only for status opens and writable otherwise", async () => {
    const store = vi.fn(async () => ({
      status: "stored" as const,
      reference: { providerId: "store", id: "1" },
    }));
    const backends = [
      backendRuntime(async () => ({ provider: handle({ store }, { store: true }) })),
    ];
    const status = createMemoryBackendAccess(backends, {
      cfg: {},
      agentId: "a",
      context,
      purpose: "status",
    });
    const statusLease = await status.access.open("store");
    await expect(statusLease.provider!.store!({ text: "x" })).rejects.toThrow("read-only");
    const normal = createMemoryBackendAccess(backends, { cfg: {}, agentId: "a", context });
    await expect(
      (await normal.access.open("store")).provider!.store!({ text: "x" }),
    ).resolves.toMatchObject({
      status: "stored",
    });
    expect(store).toHaveBeenCalledOnce();
  });

  it("closes a backend that finishes opening after the owner's lease ended", async () => {
    let release!: () => void;
    const close = vi.fn(async () => {});
    const late = handle({ close });
    const backends = [
      backendRuntime(
        () =>
          new Promise((resolve) => {
            release = () => resolve({ provider: late });
          }),
      ),
    ];
    const { access, end } = createMemoryBackendAccess(backends, { cfg: {}, agentId: "a", context });
    const opening = access.open("store");
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    await end();
    release();
    await expect(opening).rejects.toThrow(
      "memory backend access ended with the memory slot owner's lease",
    );
    expect(close).toHaveBeenCalledOnce();
  });
});

describe("backend policy edges", () => {
  it("needs a selected slot whose own manifest asks for backends", () => {
    const manifests = [
      { id: "other", memoryBackends: true },
      { id: "owner", kind: "memory" as const },
    ];
    expect(slotOwnerRequestsMemoryBackends(manifests, "owner")).toBe(false);
    expect(
      slotOwnerRequestsMemoryBackends(
        [{ id: undefined as never, memoryBackends: true }],
        undefined,
      ),
    ).toBe(false);
    expect(slotOwnerRequestsMemoryBackends(manifests, null)).toBe(false);
    expect(slotOwnerRequestsMemoryBackends([{ id: "owner", memoryBackends: true }], "owner")).toBe(
      true,
    );
  });

  it("does not request a backend without an entry opt-in or owner request", () => {
    expect(isMemoryBackendRequested(undefined, "owner", "store", "full")).toBe(false);
  });

  it("starts every load with a clean loop state", () => {
    const previous = createPluginLoadLoopState([], undefined);
    previous.seenIds.set("previous", "config");
    previous.selectedMemoryPluginId = "previous";
    previous.memorySlotMatched = true;
    previous.memoryBackendsRequested = true;
    previous.pluginLoadAttemptCount = 1;

    expect(createPluginLoadLoopState([], undefined)).toEqual({
      seenIds: new Map(),
      selectedMemoryPluginId: null,
      memorySlotMatched: false,
      memoryBackendsRequested: false,
      pluginLoadAttemptCount: 0,
    });
    expect(previous.seenIds.get("previous")).toBe("config");
    expect(previous.selectedMemoryPluginId).toBe("previous");
  });
});

describe("legacy backends", () => {
  it("forwards reload and close hooks bound to the runtime", async () => {
    const calls: string[] = [];
    const runtime = {
      getMemorySearchManager: async () => ({ manager: null }),
      resolveMemoryBackendConfig: () => ({ backend: "builtin" as const }),
      prepareReload(this: unknown) {
        calls.push(this === runtime ? "reload:bound" : "reload:unbound");
        return {
          async drain() {
            calls.push("drain");
          },
          resume() {
            calls.push("resume");
          },
        };
      },
      async closeMemorySearchManager(this: unknown) {
        calls.push(this === runtime ? "one:bound" : "one:unbound");
      },
      async closeAllMemorySearchManagers(this: unknown) {
        calls.push(this === runtime ? "all:bound" : "all:unbound");
      },
    } as unknown as MemoryPluginRuntime;
    const backend = createLegacyBackendProviderRuntime("memory-core", runtime);
    const reload = backend.prepareReload!({ retireRuntime: true, retiringEmbeddingProviders: [] });
    await reload.drain();
    reload.resume();
    await backend.closeMemorySearchManager!({ cfg: {}, agentId: "a" });
    await backend.closeAllMemorySearchManagers!();
    expect(calls).toEqual(["reload:bound", "drain", "resume", "one:bound", "all:bound"]);
    const bare = createLegacyBackendProviderRuntime("memory-core", {
      getMemorySearchManager: async () => ({ manager: null }),
      resolveMemoryBackendConfig: () => ({ backend: "builtin" as const }),
    } as unknown as MemoryPluginRuntime);
    expect(Object.keys(bare)).toEqual(["open"]);
  });

  it("warns and skips a backend with neither runtime", () => {
    const fixture = createTestPluginRegistry();
    const record = createPluginRecord({
      id: "empty",
      source: "fixture",
      origin: "config",
      enabled: true,
      configSchema: false,
    });
    record.kind = "memory";
    record.memoryBackend = true;
    fixture.registry.plugins.push(record);
    fixture
      .createApi(record, { config: {}, registrationMode: "memory-backend" })
      .registerMemoryCapability({});
    expect(fixture.registry.memoryBackends).toEqual([]);
    expect(fixture.registry.diagnostics).toContainEqual(
      expect.objectContaining({
        level: "warn",
        pluginId: "empty",
        message:
          "memory backend registered no memory runtime; the memory slot owner cannot open it",
      }),
    );
  });
});
