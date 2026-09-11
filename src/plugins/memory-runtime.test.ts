/** Covers non-activating memory registry handles and requesting-agent workspace ownership. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listRegisteredAgentHarnesses } from "../agents/harness/registry.js";
import { withCliCommandCleanup, withCliProcessScope } from "../cli/runtime-cleanup-scope.js";
import { closeCliResources } from "../cli/runtime-cleanup.js";
import type {
  LegacyMemoryReadResult,
  MemoryProviderStatus,
  MemoryReadResult,
  MemorySearchResult,
} from "../memory-host-sdk/host/types.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createPluginRecord } from "./loader-records.js";
import { createPluginCache, retirePluginCache } from "./plugin-cache.js";
import { PluginInstance } from "./plugin-instance.js";
import type {
  MemoryPluginRuntime,
  RegisteredMemorySearchManager,
} from "./registry-contribution-types.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import {
  getPluginLoaderCacheState,
  isPluginRegistryRetired,
  markPluginRegistryRetired,
} from "./registry-lifecycle.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeRegistryScope,
} from "./runtime/gateway-request-scope.js";

type AuthorizeSearchHits = NonNullable<MemoryPluginRuntime["authorizeSearchHits"]>;
type ClassifyWorkspaceMemoryPaths = NonNullable<
  MemoryPluginRuntime["classifyWorkspaceMemoryPaths"]
>;

const mocks = vi.hoisted(() => ({
  getMemoryRuntime: vi.fn(),
  loadPluginRegistryHandle: vi.fn(),
  resolveAgentWorkspaceDir: vi.fn(),
}));

vi.mock("../agents/agent-scope.js", () => ({
  resolveAgentWorkspaceDir: mocks.resolveAgentWorkspaceDir,
}));

vi.mock("./loader.js", () => ({
  loadPluginRegistryHandle: mocks.loadPluginRegistryHandle,
}));

vi.mock("./memory-state.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./memory-state.js")>();
  return { ...actual, getMemoryRuntime: mocks.getMemoryRuntime };
});

import {
  authorizeActiveMemorySearchHits,
  classifyActiveMemoryWorkspacePaths,
  closeActiveMemorySearchManagerCore,
  closeActiveMemorySearchManagersCore,
  getActiveMemorySearchManagerCore,
  resolveActiveMemoryBackendConfig,
} from "./memory-runtime.js";
import { resetStandaloneMemoryRegistrySlot } from "./memory-runtime.test-support.js";
import { hasMemoryRuntime } from "./memory-state.js";

function createRuntime() {
  return {
    authorizeSearchHits: vi.fn<AuthorizeSearchHits>(async ({ hits }) => hits),
    classifyWorkspaceMemoryPaths: vi.fn<ClassifyWorkspaceMemoryPaths>(async ({ relativePaths }) =>
      relativePaths.map((relativePath) => ({ relativePath, originClass: "agent" as const })),
    ),
    getMemorySearchManager: vi.fn(async () => ({ manager: null, error: "no index" })),
    resolveMemoryBackendConfig: vi.fn(() => ({ backend: "builtin" as const })),
    closeMemorySearchManager: vi.fn(async () => {}),
    closeAllMemorySearchManagers: vi.fn(async () => {}),
  } satisfies MemoryPluginRuntime;
}

type TestRegistry<T extends MemoryPluginRuntime> = {
  registry: ReturnType<typeof createEmptyPluginRegistry>;
  runtime: T;
  instance: PluginInstance;
};

const instances: PluginInstance[] = [];
afterEach(async () => {
  await Promise.all(instances.splice(0).map((instance) => instance.dispose()));
});

function createRegistry(): TestRegistry<ReturnType<typeof createRuntime>>;
function createRegistry<T extends MemoryPluginRuntime>(runtime: T): TestRegistry<T>;
function createRegistry(
  runtime: MemoryPluginRuntime = createRuntime(),
): TestRegistry<MemoryPluginRuntime> {
  const registry = createEmptyPluginRegistry();
  const record = createPluginRecord({
    id: "memory-core",
    source: "/plugins/memory-core/index.js",
    origin: "config",
    enabled: true,
    configSchema: false,
  });
  const instance = new PluginInstance(record.id, { record, registry });
  instances.push(instance);
  registry.plugins.push(record);
  registry.memoryCapabilities.push({
    pluginId: record.id,
    capability: instance.wrap({ runtime }),
  });
  return { registry, runtime, instance };
}

const memoryConfig = {
  plugins: { slots: { memory: "memory-core" } },
} as never;

describe("memory runtime handles", () => {
  beforeEach(() => {
    resetStandaloneMemoryRegistrySlot();
    mocks.getMemoryRuntime.mockReset().mockReturnValue(undefined);
    mocks.loadPluginRegistryHandle.mockReset();
    mocks.resolveAgentWorkspaceDir
      .mockReset()
      .mockImplementation((_cfg, agentId: string) =>
        agentId === "research" ? "/workspace/research" : "/workspace/main",
      );
  });

  it.each([
    ["all", "retired"],
    ["all", "quiesced"],
    ["agent", "retired"],
    ["agent", "quiesced"],
  ] as const)(
    "closes %s managers through a %s owner without reviving disposal",
    async (scope, state) => {
      const { registry, runtime, instance } = createRegistry();
      mocks.loadPluginRegistryHandle.mockReturnValue(registry);
      await getActiveMemorySearchManagerCore({ cfg: memoryConfig, agentId: "main" });
      const releaseClose = createDeferredCore();
      const closeCallback =
        scope === "all" ? runtime.closeAllMemorySearchManagers : runtime.closeMemorySearchManager;
      closeCallback.mockImplementationOnce(async () => {
        await releaseClose.promise;
      });
      const close = () =>
        scope === "all"
          ? closeActiveMemorySearchManagersCore()
          : closeActiveMemorySearchManagerCore({ cfg: memoryConfig, agentId: "main" });
      if (state === "retired") {
        markPluginRegistryRetired(registry);
      } else {
        instance.quiesce();
      }
      const closing = close();
      void closing.catch(() => {});
      try {
        expect(closeCallback).toHaveBeenCalledTimes(1);
        expect(closeCallback.mock.contexts[0]).toBe(runtime);
        const disposal = instance.dispose();
        expect(instance.lifecycle.signal.aborted).toBe(false);
        releaseClose.resolve();
        await Promise.all([closing, disposal]);
        expect(instance.lifecycle.signal.aborted).toBe(true);
        await expect(close()).resolves.toBeUndefined();
        expect(closeCallback).toHaveBeenCalledTimes(1);
      } finally {
        releaseClose.resolve();
        await Promise.allSettled([closing, instance.dispose()]);
      }
    },
  );

  it("closes memory after the CLI retires its acquired harness registry", async () => {
    const { registry, runtime, instance } = createRegistry();
    const disposeHarness = vi.fn(async () => {});
    registry.agentHarnesses.push({
      pluginId: "memory-core",
      source: "/plugins/memory-core/index.js",
      harness: instance.wrap({
        id: "memory-fixture",
        label: "Memory fixture",
        supports: () => ({ supported: true }),
        runAttempt: async () => {
          throw new Error("catalog-only fixture");
        },
        dispose: disposeHarness,
      }),
    });
    mocks.loadPluginRegistryHandle.mockReturnValue(registry);
    runtime.closeAllMemorySearchManagers.mockImplementationOnce(async () => {
      expect(isPluginRegistryRetired(registry)).toBe(true);
      expect(instance.lifecycle.signal.aborted).toBe(false);
    });
    await withCliProcessScope(() =>
      withCliCommandCleanup(false, async (cleanup) => {
        await getActiveMemorySearchManagerCore({ cfg: memoryConfig, agentId: "main" });
        withPluginRuntimeRegistryScope(registry, listRegisteredAgentHarnesses);
        await closeCliResources(cleanup);
      }),
    );
    expect(disposeHarness).toHaveBeenCalledTimes(1);
    expect(runtime.closeAllMemorySearchManagers).toHaveBeenCalledTimes(1);
  });

  it("loads only the selected memory plugin into a non-activating handle", async () => {
    const { registry, runtime } = createRegistry();
    runtime.getMemorySearchManager.mockImplementationOnce(async () => {
      expect(getPluginRuntimeGatewayRequestScope()?.pluginRegistry).toBe(registry);
      return { manager: null, error: "no index" };
    });
    runtime.resolveMemoryBackendConfig.mockImplementationOnce(() => {
      expect(getPluginRuntimeGatewayRequestScope()?.pluginRegistry).toBe(registry);
      return { backend: "builtin" };
    });
    mocks.loadPluginRegistryHandle.mockReturnValue(registry);

    await expect(
      getActiveMemorySearchManagerCore({ cfg: memoryConfig, agentId: "main" }),
    ).resolves.toEqual({ manager: null, error: "no index" });

    expect(mocks.loadPluginRegistryHandle).toHaveBeenCalledWith({
      activate: false,
      config: memoryConfig,
      onlyPluginIds: ["memory-core"],
      workspaceDir: "/workspace/main",
    });
    expect(runtime.getMemorySearchManager).toHaveBeenCalledWith({
      cfg: memoryConfig,
      agentId: "main",
    });
    expect(resolveActiveMemoryBackendConfig({ cfg: memoryConfig, agentId: "main" })).toEqual({
      backend: "builtin",
    });
  });

  it("tracks standalone managers without activating config-only lookups and rearms reused handles", async () => {
    const { registry, runtime } = createRegistry();
    mocks.loadPluginRegistryHandle.mockReturnValue(registry);

    expect(hasMemoryRuntime()).toBe(false);
    expect(resolveActiveMemoryBackendConfig({ cfg: memoryConfig, agentId: "main" })).toEqual({
      backend: "builtin",
    });
    expect(hasMemoryRuntime()).toBe(false);

    await getActiveMemorySearchManagerCore({ cfg: memoryConfig, agentId: "main" });
    expect(hasMemoryRuntime()).toBe(true);

    await closeActiveMemorySearchManagersCore();
    expect(hasMemoryRuntime()).toBe(false);

    await getActiveMemorySearchManagerCore({ cfg: memoryConfig, agentId: "main" });
    expect(hasMemoryRuntime()).toBe(true);
    expect(runtime.getMemorySearchManager).toHaveBeenCalledTimes(2);

    await closeActiveMemorySearchManagersCore();
    expect(runtime.closeAllMemorySearchManagers).toHaveBeenCalledTimes(2);
    expect(hasMemoryRuntime()).toBe(false);
  });

  it.each(["present", "missing"] as const)(
    "reloads the same memory selection after its %s capability owner retires",
    async (capability) => {
      const first = createRegistry();
      const replacement = createRegistry();
      if (capability === "missing") {
        first.registry.memoryCapabilities = [];
      }
      const cache = createPluginCache();
      getPluginLoaderCacheState(cache).set("memory-fixture", first.registry);
      mocks.loadPluginRegistryHandle
        .mockReturnValueOnce(first.registry)
        .mockReturnValue(replacement.registry);

      await expect(
        getActiveMemorySearchManagerCore({ cfg: memoryConfig, agentId: "main" }),
      ).resolves.toEqual({
        manager: null,
        error: capability === "missing" ? "memory plugin unavailable" : "no index",
      });
      await retirePluginCache(cache);
      expect(first.instance.lifecycle.signal.aborted).toBe(true);

      for (let query = 0; query < 2; query += 1) {
        await expect(
          getActiveMemorySearchManagerCore({ cfg: memoryConfig, agentId: "main" }),
        ).resolves.toEqual({ manager: null, error: "no index" });
      }
      expect(replacement.runtime.getMemorySearchManager).toHaveBeenCalledTimes(2);
      expect(replacement.instance.lifecycle.signal.aborted).toBe(false);
      await closeActiveMemorySearchManagersCore();
      expect(replacement.runtime.closeAllMemorySearchManagers).toHaveBeenCalledOnce();
    },
  );

  it("enrolls cached standalone runtimes once across selection and cleanup resets", async () => {
    const first = createRegistry();
    const second = createRegistry();
    const observeRegistration = (instance: PluginInstance) => {
      const onDispose = vi.fn(instance.lifecycle.onDispose);
      // Observe the public call while retaining the real instance's registration and signal.
      Object.defineProperty(instance, "lifecycle", {
        value: Object.freeze({ ...instance.lifecycle, onDispose }),
      });
      return onDispose;
    };
    const firstDisposals = observeRegistration(first.instance);
    const secondDisposals = observeRegistration(second.instance);
    mocks.loadPluginRegistryHandle.mockImplementation(({ workspaceDir }) =>
      workspaceDir === "/workspace/research" ? second.registry : first.registry,
    );
    const alternate = async () => {
      for (const agentId of ["main", "research", "main"]) {
        await getActiveMemorySearchManagerCore({ cfg: memoryConfig, agentId });
      }
    };
    await alternate();
    expect.soft(firstDisposals).toHaveBeenCalledOnce();
    expect.soft(secondDisposals).toHaveBeenCalledOnce();
    await closeActiveMemorySearchManagersCore();
    resetStandaloneMemoryRegistrySlot();
    await alternate();
    expect.soft(firstDisposals).toHaveBeenCalledOnce();
    expect.soft(secondDisposals).toHaveBeenCalledOnce();

    await second.instance.dispose();
    await closeActiveMemorySearchManagersCore();
    expect(first.runtime.closeAllMemorySearchManagers).toHaveBeenCalledTimes(2);
    expect(second.runtime.closeAllMemorySearchManagers).toHaveBeenCalledOnce();
    await first.instance.dispose();
    await closeActiveMemorySearchManagersCore();
    expect(first.runtime.closeAllMemorySearchManagers).toHaveBeenCalledTimes(2);

    const fresh = createRegistry(first.runtime);
    const freshDisposals = observeRegistration(fresh.instance);
    mocks.loadPluginRegistryHandle.mockReturnValue(fresh.registry);
    await getActiveMemorySearchManagerCore({ cfg: memoryConfig, agentId: "main" });
    expect(freshDisposals).toHaveBeenCalledOnce();
  });

  it("retiring an older workspace removes only that runtime from memory cleanup", async () => {
    const first = createRegistry();
    const current = createRegistry();
    const cache = createPluginCache();
    getPluginLoaderCacheState(cache).set("memory-fixture", first.registry);
    mocks.loadPluginRegistryHandle
      .mockReturnValueOnce(first.registry)
      .mockReturnValue(current.registry);

    await getActiveMemorySearchManagerCore({ cfg: memoryConfig, agentId: "main" });
    await getActiveMemorySearchManagerCore({ cfg: memoryConfig, agentId: "research" });
    await retirePluginCache(cache);
    await getActiveMemorySearchManagerCore({ cfg: memoryConfig, agentId: "research" });

    await expect(closeActiveMemorySearchManagersCore()).resolves.toBeUndefined();
    expect(current.runtime.getMemorySearchManager).toHaveBeenCalledTimes(2);
    expect(current.runtime.closeAllMemorySearchManagers).toHaveBeenCalledOnce();
  });

  it("retains standalone ownership across workspace replacement and per-agent cleanup", async () => {
    const main = createRegistry();
    const research = createRegistry();
    mocks.loadPluginRegistryHandle
      .mockReturnValueOnce(main.registry)
      .mockReturnValueOnce(research.registry);

    await getActiveMemorySearchManagerCore({ cfg: memoryConfig, agentId: "main" });
    await getActiveMemorySearchManagerCore({ cfg: memoryConfig, agentId: "research" });
    expect(hasMemoryRuntime()).toBe(true);

    await closeActiveMemorySearchManagerCore({ cfg: memoryConfig, agentId: "main" });
    expect(hasMemoryRuntime()).toBe(true);

    await closeActiveMemorySearchManagersCore();
    expect(main.runtime.closeAllMemorySearchManagers).toHaveBeenCalledTimes(1);
    expect(research.runtime.closeAllMemorySearchManagers).toHaveBeenCalledTimes(1);
    expect(hasMemoryRuntime()).toBe(false);
  });

  it("retains standalone cleanup ownership when manager acquisition or teardown fails", async () => {
    const { registry, runtime } = createRegistry();
    mocks.loadPluginRegistryHandle.mockReturnValue(registry);
    runtime.getMemorySearchManager.mockRejectedValueOnce(
      new Error("manager initialization failed"),
    );

    await expect(
      getActiveMemorySearchManagerCore({ cfg: memoryConfig, agentId: "main" }),
    ).rejects.toThrow("manager initialization failed");
    expect(hasMemoryRuntime()).toBe(true);

    runtime.closeAllMemorySearchManagers.mockRejectedValueOnce(
      new Error("manager teardown failed"),
    );
    await expect(closeActiveMemorySearchManagersCore()).rejects.toThrow("manager teardown failed");
    expect(hasMemoryRuntime()).toBe(true);

    await closeActiveMemorySearchManagersCore();
    expect(hasMemoryRuntime()).toBe(false);
  });

  it("selects the memory runtime for the requesting agent workspace", () => {
    const main = createRegistry();
    const research = createRegistry();
    mocks.loadPluginRegistryHandle.mockImplementation(({ workspaceDir }) =>
      workspaceDir === "/workspace/research" ? research.registry : main.registry,
    );

    expect(resolveActiveMemoryBackendConfig({ cfg: memoryConfig, agentId: "main" })).toEqual({
      backend: "builtin",
    });
    expect(resolveActiveMemoryBackendConfig({ cfg: memoryConfig, agentId: "main" })).toEqual({
      backend: "builtin",
    });
    expect(resolveActiveMemoryBackendConfig({ cfg: memoryConfig, agentId: "research" })).toEqual({
      backend: "builtin",
    });

    expect(mocks.resolveAgentWorkspaceDir).toHaveBeenNthCalledWith(1, memoryConfig, "main");
    expect(mocks.resolveAgentWorkspaceDir).toHaveBeenLastCalledWith(memoryConfig, "research");
    expect(main.runtime.resolveMemoryBackendConfig).toHaveBeenCalledTimes(2);
    expect(research.runtime.resolveMemoryBackendConfig).toHaveBeenCalledOnce();
  });

  it.each([
    { plugins: { enabled: false } },
    { plugins: { slots: { memory: "none" } } },
    { plugins: { slots: { memory: "memory-core" }, deny: ["memory-core"] } },
    {
      plugins: {
        slots: { memory: "memory-core" },
        entries: { "memory-core": { enabled: false } },
      },
    },
  ])("does not load a disabled memory selection", async (cfg) => {
    await expect(
      getActiveMemorySearchManagerCore({ cfg: cfg as never, agentId: "main" }),
    ).resolves.toEqual({ manager: null, error: "memory plugin unavailable" });
    expect(mocks.loadPluginRegistryHandle).not.toHaveBeenCalled();
  });

  it("prefers an already-registered runtime", () => {
    const runtime = createRuntime();
    mocks.getMemoryRuntime.mockReturnValue(runtime);

    expect(resolveActiveMemoryBackendConfig({ cfg: memoryConfig, agentId: "main" })).toEqual({
      backend: "builtin",
    });
    expect(mocks.loadPluginRegistryHandle).not.toHaveBeenCalled();
  });

  it("preserves statusless reads as successful while preserving manager lifecycle", async () => {
    const canonicalEmpty = {
      status: "ok",
      text: "",
      path: "memory/canonical-empty.md",
    } as const satisfies MemoryReadResult;
    const canonicalMissing = {
      status: "not_found",
      text: "",
      path: "memory/canonical-missing.md",
    } as const satisfies MemoryReadResult;

    class RegisteredReadManager implements RegisteredMemorySearchManager {
      #closed = false;
      #readCalls = 0;

      async search(): Promise<MemorySearchResult[]> {
        return [];
      }

      async readFile({
        relPath,
      }: {
        relPath: string;
      }): Promise<LegacyMemoryReadResult | MemoryReadResult> {
        this.#readCalls += 1;
        switch (relPath) {
          case "memory/legacy-bare-empty.md":
            return { text: "", path: relPath };
          case "memory/legacy-ranged-empty.md":
            return { text: "", path: relPath, from: 1, lines: 0 };
          case "memory/legacy-nonempty.md":
            return { text: "legacy", path: relPath };
          case canonicalEmpty.path:
            return canonicalEmpty;
          case canonicalMissing.path:
            return canonicalMissing;
          default:
            throw new Error(`unexpected read path: ${relPath}`);
        }
      }

      status(): MemoryProviderStatus {
        return { backend: "builtin", provider: "builtin" };
      }

      async probeEmbeddingAvailability() {
        return { ok: true };
      }

      async probeVectorAvailability() {
        return true;
      }

      async close() {
        this.#closed = true;
      }

      isClosed() {
        return this.#closed;
      }

      readCalls() {
        return this.#readCalls;
      }
    }
    const manager = new RegisteredReadManager();
    const runtime = {
      ...createRuntime(),
      getMemorySearchManager: vi.fn(async () => ({
        manager,
      })),
    } satisfies MemoryPluginRuntime;
    mocks.getMemoryRuntime.mockReturnValue(runtime);

    const first = await getActiveMemorySearchManagerCore({ cfg: memoryConfig, agentId: "main" });
    const second = await getActiveMemorySearchManagerCore({ cfg: memoryConfig, agentId: "main" });

    expect(second.manager).toBe(first.manager);
    expect(Reflect.get(second.manager ?? {}, "readFile")).toBe(
      Reflect.get(first.manager ?? {}, "readFile"),
    );
    await expect(
      first.manager?.readFile({ relPath: "memory/legacy-bare-empty.md" }),
    ).resolves.toEqual({
      status: "ok",
      text: "",
      path: "memory/legacy-bare-empty.md",
    });
    await expect(
      first.manager?.readFile({ relPath: "memory/legacy-ranged-empty.md" }),
    ).resolves.toEqual({
      status: "ok",
      text: "",
      path: "memory/legacy-ranged-empty.md",
      from: 1,
      lines: 0,
    });
    await expect(
      first.manager?.readFile({ relPath: "memory/legacy-nonempty.md" }),
    ).resolves.toEqual({
      status: "ok",
      text: "legacy",
      path: "memory/legacy-nonempty.md",
    });
    await expect(first.manager?.readFile({ relPath: canonicalEmpty.path })).resolves.toBe(
      canonicalEmpty,
    );
    await expect(first.manager?.readFile({ relPath: canonicalMissing.path })).resolves.toBe(
      canonicalMissing,
    );
    await first.manager?.close?.();
    expect(manager.isClosed()).toBe(true);
    expect(manager.readCalls()).toBe(5);
  });

  it("supports frozen registered managers without violating proxy invariants", async () => {
    let closed = false;
    let probed = false;
    const manager = Object.freeze({
      search: async () => [],
      readFile: async ({ relPath }: { relPath: string }) => ({
        text: "frozen",
        path: relPath,
      }),
      status: () => ({ backend: "builtin" as const, provider: probed ? "ready" : "frozen" }),
      probeEmbeddingAvailability: async () => {
        probed = true;
        return { ok: true };
      },
      probeVectorAvailability: async () => true,
      close: async () => {
        closed = true;
      },
    }) satisfies RegisteredMemorySearchManager;
    const runtime = {
      ...createRuntime(),
      getMemorySearchManager: vi.fn(async () => ({ manager })),
    } satisfies MemoryPluginRuntime;
    mocks.getMemoryRuntime.mockReturnValue(runtime);

    const acquired = await getActiveMemorySearchManagerCore({ cfg: memoryConfig, agentId: "main" });

    await expect(acquired.manager?.search("frozen manager")).resolves.toEqual([]);
    expect(acquired.manager?.status()).toEqual({ backend: "builtin", provider: "frozen" });
    await expect(acquired.manager?.probeEmbeddingAvailability()).resolves.toEqual({ ok: true });
    expect(acquired.manager?.status()).toEqual({ backend: "builtin", provider: "ready" });
    await expect(acquired.manager?.probeVectorAvailability()).resolves.toBe(true);
    await expect(acquired.manager?.readFile({ relPath: "memory/frozen.md" })).resolves.toEqual({
      status: "ok",
      text: "frozen",
      path: "memory/frozen.md",
    });
    await acquired.manager?.close?.();
    expect(closed).toBe(true);
  });

  it("authorizes raw hits inside the selected plugin runtime scope", async () => {
    const { registry, runtime } = createRegistry();
    runtime.authorizeSearchHits.mockImplementationOnce(async ({ hits }) => {
      expect(getPluginRuntimeGatewayRequestScope()?.pluginRegistry).toBe(registry);
      return hits.filter((hit) => hit.source === "memory");
    });
    mocks.loadPluginRegistryHandle.mockReturnValue(registry);
    const hits: MemorySearchResult[] = [
      {
        source: "memory",
        path: "memory.md",
        startLine: 1,
        endLine: 1,
        score: 1,
        snippet: "memory",
      },
      {
        source: "sessions",
        path: "sessions/private.jsonl",
        startLine: 1,
        endLine: 1,
        score: 1,
        snippet: "private",
      },
    ];

    await expect(
      authorizeActiveMemorySearchHits({
        cfg: memoryConfig,
        agentId: "main",
        requesterSessionKey: "agent:main:voice:15550001234",
        sandboxed: false,
        hits,
      }),
    ).resolves.toEqual([hits[0]]);
  });

  it("classifies workspace paths inside the selected plugin runtime scope", async () => {
    const { registry, runtime } = createRegistry();
    runtime.classifyWorkspaceMemoryPaths.mockImplementationOnce(async ({ relativePaths }) => {
      expect(getPluginRuntimeGatewayRequestScope()?.pluginRegistry).toBe(registry);
      return relativePaths.map((relativePath) => ({
        relativePath,
        originClass: relativePath === "MEMORY.md" ? "untrusted" : "owner",
      }));
    });
    mocks.loadPluginRegistryHandle.mockReturnValue(registry);

    await expect(
      classifyActiveMemoryWorkspacePaths({
        cfg: memoryConfig,
        agentId: "main",
        workspaceDir: "/workspace/main",
        relativePaths: ["MEMORY.md", "USER.md"],
      }),
    ).resolves.toEqual({
      status: "classified",
      classifications: [
        { relativePath: "MEMORY.md", originClass: "untrusted" },
        { relativePath: "USER.md", originClass: "owner" },
      ],
    });
  });

  it("distinguishes a selected runtime without workspace provenance support", async () => {
    const runtimeWithoutClassifier = {
      getMemorySearchManager: vi.fn(async () => ({ manager: null, error: "no index" })),
      resolveMemoryBackendConfig: vi.fn(() => ({ backend: "builtin" as const })),
    } satisfies MemoryPluginRuntime;
    mocks.loadPluginRegistryHandle.mockReturnValue(
      createRegistry(runtimeWithoutClassifier).registry,
    );

    await expect(
      classifyActiveMemoryWorkspacePaths({
        cfg: memoryConfig,
        agentId: "main",
        workspaceDir: "/workspace/main",
        relativePaths: ["MEMORY.md", "USER.md"],
      }),
    ).resolves.toEqual({ status: "unsupported" });
  });

  it("fails closed on session hits when a memory runtime has no authorizer", async () => {
    const runtimeWithoutAuthorizer = {
      getMemorySearchManager: vi.fn(async () => ({ manager: null, error: "no index" })),
      resolveMemoryBackendConfig: vi.fn(() => ({ backend: "builtin" as const })),
      closeMemorySearchManager: vi.fn(async () => {}),
      closeAllMemorySearchManagers: vi.fn(async () => {}),
    } satisfies MemoryPluginRuntime;
    mocks.loadPluginRegistryHandle.mockReturnValue(
      createRegistry(runtimeWithoutAuthorizer).registry,
    );
    const hits: MemorySearchResult[] = [
      {
        source: "memory",
        path: "memory.md",
        startLine: 1,
        endLine: 1,
        score: 1,
        snippet: "memory",
      },
      {
        source: "sessions",
        path: "sessions/private.jsonl",
        startLine: 1,
        endLine: 1,
        score: 1,
        snippet: "private",
      },
    ];

    await expect(
      authorizeActiveMemorySearchHits({
        cfg: memoryConfig,
        agentId: "main",
        requesterSessionKey: "agent:main:voice:15550001234",
        sandboxed: false,
        hits,
      }),
    ).resolves.toEqual([hits[0]]);
  });

  it("closes managers through current and retired workspace handles without reloading", async () => {
    const main = createRegistry();
    const research = createRegistry();
    for (const owner of [main, research]) {
      owner.runtime.closeMemorySearchManager.mockImplementationOnce(async () => {
        expect(getPluginRuntimeGatewayRequestScope()?.pluginRegistry).toBe(owner.registry);
      });
      owner.runtime.closeAllMemorySearchManagers.mockImplementationOnce(async () => {
        expect(getPluginRuntimeGatewayRequestScope()?.pluginRegistry).toBe(owner.registry);
      });
    }
    mocks.loadPluginRegistryHandle
      .mockReturnValueOnce(main.registry)
      .mockReturnValueOnce(research.registry);
    resolveActiveMemoryBackendConfig({ cfg: memoryConfig, agentId: "main" });
    resolveActiveMemoryBackendConfig({ cfg: memoryConfig, agentId: "research" });
    mocks.loadPluginRegistryHandle.mockClear();

    await closeActiveMemorySearchManagerCore({ cfg: memoryConfig, agentId: "main" });
    await closeActiveMemorySearchManagersCore(memoryConfig);

    for (const { runtime } of [main, research]) {
      expect(runtime.closeMemorySearchManager).toHaveBeenCalledWith({
        cfg: memoryConfig,
        agentId: "main",
      });
      expect(runtime.closeAllMemorySearchManagers).toHaveBeenCalledTimes(1);
    }
    expect(mocks.loadPluginRegistryHandle).not.toHaveBeenCalled();
  });
});
