import assert from "node:assert/strict";
import { expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { EmbeddingProviderAdapter } from "./embedding-provider-types.js";
import { createPluginRecord } from "./loader-records.js";
import { activatePluginRegistry } from "./loader-shared.js";
import { getMemoryEmbeddingProvider } from "./memory-embedding-provider-runtime.js";
import { prepareMemoryRuntimeReload } from "./memory-runtime.js";
import { getPluginInstance } from "./plugin-instance-scope.js";
import type { MemoryPluginRuntime } from "./registry-contribution-types.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { createPluginRegistry } from "./registry.js";
import { disposePluginRegistryInstances } from "./runtime.js";
import { getPluginRuntimeGatewayRequestScope } from "./runtime/gateway-request-scope.js";
import type { PluginRuntime } from "./runtime/types.js";

const { memoryRuntime } = await vi.importActual<{ memoryRuntime: MemoryPluginRuntime }>(
  "../../extensions/memory-core/runtime-api.js",
);

it("keeps persistent managers isolated between memory runtime instances with the same agent", async () => {
  const state = await createOpenClawTestState({
    scenario: "minimal",
    label: "memory-runtime-owners",
  });
  const config: OpenClawConfig = {
    plugins: { enabled: false },
    agents: { defaults: { workspace: state.workspaceDir } },
    memory: {
      search: {
        provider: "none",
        store: { vector: { enabled: false } },
      },
    },
  };
  const first = registerMemoryOwner(config);
  const second = registerMemoryOwner(config);
  try {
    const one = await first.runtime.getMemorySearchManager({ cfg: config, agentId: "main" });
    const two = await second.runtime.getMemorySearchManager({ cfg: config, agentId: "main" });
    assert(one.manager, one.error ?? "Expected a memory manager");
    assert(two.manager, two.error ?? "Expected a memory manager");
    await first.runtime.closeAllMemorySearchManagers?.();
    expect(two.manager.status().sources).toBeDefined();
    await expect(two.manager.search("sibling still live")).resolves.toEqual([]);
  } finally {
    await first.runtime.closeAllMemorySearchManagers?.();
    await second.runtime.closeAllMemorySearchManagers?.();
    await disposePluginRegistryInstances(first.registry);
    await disposePluginRegistryInstances(second.registry);
    await state.cleanup();
  }
});

function registerMemoryOwner(
  config: OpenClawConfig,
  runtimeImplementation: MemoryPluginRuntime = memoryRuntime,
) {
  const owner = createPluginRegistry({
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    runtime: {} as PluginRuntime,
    activateGlobalSideEffects: false,
  });
  const record = createPluginRecord({
    id: "memory-fixture",
    source: "fixture",
    origin: "config",
    enabled: true,
    configSchema: false,
  });
  record.kind = "memory";
  record.memorySlotSelected = true;
  owner.registry.plugins.push(record);
  const api = owner.createApi(record, { config });
  api.registerMemoryCapability({ runtime: runtimeImplementation });
  const runtime = owner.registry.memoryCapabilities[0]?.capability.runtime;
  assert(runtime);
  return { ...owner, record, runtime, instance: getPluginInstance(record)! };
}

function registerAdapter(
  owner: ReturnType<typeof registerMemoryOwner>,
  config: OpenClawConfig,
  adapter: EmbeddingProviderAdapter,
) {
  const record = createPluginRecord({
    id: adapter.id,
    source: "fixture",
    origin: "config",
    enabled: true,
    configSchema: false,
    contracts: { embeddingProviders: [adapter.id] },
  });
  owner.registry.plugins.push(record);
  owner.createApi(record, { config }).registerEmbeddingProvider(adapter);
  return { record, registration: owner.registry.embeddingProviders.at(-1)! };
}

it.each([
  "ready",
  "legacy-retained",
  "pending-primary",
  "pending-fallback",
  "healthy-fallback",
  "unavailable-create",
  "failed-close",
  "timeout",
  "late-probe",
  "transient",
] as const)("drains the actual managed embedding owner before replacement (%s)", async (mode) => {
  const state = await createOpenClawTestState({
    scenario: "minimal",
    label: "memory-provider-reload",
  });
  const fallback = mode === "pending-fallback" || mode === "healthy-fallback";
  const providerId = fallback ? "primary-probe" : "embedding-probe";
  const targetId = fallback ? "fallback-probe" : providerId;
  const config: OpenClawConfig = {
    plugins: { enabled: false },
    agents: { defaults: { workspace: state.workspaceDir } },
    memory: {
      search: {
        provider: providerId,
        model: "synthetic-embedding",
        fallback: fallback ? targetId : "none",
        store: { vector: { enabled: false } },
      },
    },
  };
  const legacyRuntime = { ...memoryRuntime };
  delete legacyRuntime.prepareReload;
  const owner = registerMemoryOwner(
    config,
    mode === "legacy-retained" ? legacyRuntime : memoryRuntime,
  );
  const sibling = registerMemoryOwner(config);
  const successor = registerMemoryOwner(config);
  const entered = createDeferredCore();
  const releaseCreate = createDeferredCore();
  const releaseClose = createDeferredCore();
  const probeEntered = createDeferredCore();
  const releaseProbe = createDeferredCore();
  let rejectClose = mode === "failed-close";
  const embedBatch = vi.fn(async () => {
    probeEntered.resolve();
    if (mode === "late-probe") {
      await releaseProbe.promise;
    }
    return [[1, 0, 0]];
  });
  const create = vi.fn(async () => {
    entered.resolve();
    if (mode === "unavailable-create") {
      return { provider: null };
    }
    if (mode.startsWith("pending")) {
      await releaseCreate.promise;
    }
    return {
      provider: {
        id: targetId,
        model: "synthetic-embedding",
        embed: async () => [1, 0, 0],
        embedBatch,
        close,
      },
    };
  });
  const close = vi.fn(async () => {
    expect(getPluginRuntimeGatewayRequestScope()?.pluginId).toBe(targetId);
    if (rejectClose) {
      throw new Error("synthetic provider cleanup refused");
    }
    if (mode === "timeout") {
      await releaseClose.promise;
    }
  });
  const adapter = { id: targetId, transport: "remote" as const, create };
  if (fallback) {
    registerAdapter(owner, config, {
      id: providerId,
      create: async () => {
        throw new Error("synthetic primary unavailable");
      },
    });
  }
  const retiring = registerAdapter(owner, config, adapter);
  const siblingClose = vi.fn(async () => {});
  registerAdapter(sibling, config, {
    id: providerId,
    create: async () => ({
      provider: {
        id: providerId,
        model: "synthetic-embedding",
        embed: async () => [1, 0, 0],
        embedBatch: async () => [[1, 0, 0]],
        close: siblingClose,
      },
    }),
  });
  const successorClose = vi.fn(async () => {});
  const replacement = registerAdapter(successor, config, {
    id: targetId,
    create: async () => ({
      provider:
        mode === "late-probe"
          ? null
          : {
              id: targetId,
              model: "synthetic-embedding",
              embed: async () => [1, 0, 0],
              embedBatch: async () => [[1, 0, 0]],
              close: successorClose,
            },
    }),
  });
  const unaffectedConfig = {
    ...config,
    memory: { search: { ...config.memory?.search, provider: "unaffected-probe" } },
  };
  const unaffectedClose = vi.fn(async () => {});
  if (mode === "ready") {
    registerAdapter(owner, unaffectedConfig, {
      id: "unaffected-probe",
      create: async () => ({
        provider: {
          id: "unaffected-probe",
          model: "synthetic-embedding",
          embed: async () => [1, 0, 0],
          embedBatch: async () => [[1, 0, 0]],
          close: unaffectedClose,
        },
      }),
    });
  }
  const next = createEmptyPluginRegistry();
  next.plugins.push(
    ...owner.registry.plugins.filter((record) => record !== retiring.record),
    replacement.record,
  );
  next.memoryCapabilities.push(...owner.registry.memoryCapabilities);
  next.embeddingProviders.push(
    ...owner.registry.embeddingProviders.filter((entry) => entry !== retiring.registration),
    replacement.registration,
  );
  let probe: Promise<unknown> | undefined;
  let drain: ReturnType<ReturnType<typeof prepareMemoryRuntimeReload>["drain"]> | undefined;
  try {
    expect(owner.instance.run(() => getMemoryEmbeddingProvider(targetId, config))).toBe(
      retiring.registration.provider,
    );
    let result = await owner.runtime.getMemorySearchManager({
      cfg: config,
      agentId: "main",
      ...(mode === "transient" ? { purpose: "cli" } : {}),
    });
    const other = await sibling.runtime.getMemorySearchManager({ cfg: config, agentId: "main" });
    assert(result.manager, result.error ?? "Expected a memory manager");
    assert(other.manager, other.error ?? "Expected a memory manager");
    await other.manager.probeEmbeddingAvailability();
    probe = result.manager.probeEmbeddingAvailability();
    await entered.promise;
    if (mode === "late-probe") {
      await probeEntered.promise;
    } else if (!mode.startsWith("pending")) {
      await probe;
    }
    if (mode === "healthy-fallback") {
      const primaryOnly = prepareMemoryRuntimeReload(owner.registry, {
        ...owner.registry,
        embeddingProviders: owner.registry.embeddingProviders.filter(
          (entry) => entry !== owner.registry.embeddingProviders[0],
        ),
      });
      await primaryOnly.drain();
      await expect(result.manager.probeEmbeddingAvailability()).rejects.toThrow("closed");
      expect(close).toHaveBeenCalledOnce();
      primaryOnly.rollback();
      const previousManager = result.manager;
      result = await owner.runtime.getMemorySearchManager({ cfg: config, agentId: "main" });
      assert(result.manager, result.error ?? "Expected a fresh fallback manager");
      expect(result.manager).not.toBe(previousManager);
      await expect(result.manager.probeEmbeddingAvailability()).resolves.toMatchObject({
        ok: true,
      });
    }
    if (mode === "legacy-retained") {
      const unchanged = prepareMemoryRuntimeReload(owner.registry, owner.registry);
      await unchanged.drain();
      unchanged.commit();
      expect(close).not.toHaveBeenCalled();
    }
    if (mode === "ready") {
      const unaffected = await owner.runtime.getMemorySearchManager({
        cfg: unaffectedConfig,
        agentId: "unaffected",
      });
      assert(unaffected.manager, unaffected.error ?? "Expected an unaffected manager");
      await unaffected.manager.probeEmbeddingAvailability();
      const prepared = prepareMemoryRuntimeReload(owner.registry, next);
      const probesBeforeAcquisition = embedBatch.mock.calls.length;
      try {
        const retained = await owner.runtime.getMemorySearchManager({
          cfg: unaffectedConfig,
          agentId: "unaffected",
        });
        expect(retained.manager).toBe(unaffected.manager);
        await expect(retained.manager?.probeEmbeddingAvailability()).resolves.toMatchObject({
          ok: true,
        });
        const late = await owner.runtime.getMemorySearchManager({ cfg: config, agentId: "main" });
        if (late.manager) {
          await late.manager.probeEmbeddingAvailability();
        }
        expect({ hasManager: late.manager !== null, error: late.error }).toEqual({
          hasManager: false,
          error: expect.stringContaining("reloading"),
        });
        expect(embedBatch).toHaveBeenCalledTimes(probesBeforeAcquisition);
        expect(close).not.toHaveBeenCalled();
        expect(unaffectedClose).not.toHaveBeenCalled();
      } finally {
        prepared.rollback();
      }
      const resumed = await owner.runtime.getMemorySearchManager({ cfg: config, agentId: "main" });
      expect(resumed.manager).toBe(result.manager);
      await expect(resumed.manager?.probeEmbeddingAvailability()).resolves.toMatchObject({
        ok: true,
      });
    }
    const providerClosesBeforeReload = close.mock.calls.length;
    const reload = prepareMemoryRuntimeReload(owner.registry, next);
    let drained = false;
    drain = reload.drain().then((drainResult) => {
      drained = true;
      return drainResult;
    });
    if (mode.startsWith("pending")) {
      await Promise.resolve();
      expect(drained).toBe(false);
      expect(close).not.toHaveBeenCalled();
    }
    if (mode !== "legacy-retained") {
      // Only prepareReload declares an admission fence for concurrent acquisition.
      const creationsBeforeLateAcquisition = create.mock.calls.length;
      const late = await owner.runtime.getMemorySearchManager({ cfg: config, agentId: "late" });
      assert(late.manager, late.error ?? "Expected a memory manager");
      await expect(late.manager.probeEmbeddingAvailability()).rejects.toThrow("reloading");
      expect(create).toHaveBeenCalledTimes(creationsBeforeLateAcquisition);
    }
    releaseCreate.resolve();
    if (mode !== "late-probe") {
      await probe;
    }
    if (mode === "failed-close") {
      await expect(drain).resolves.toMatchObject({
        errors: [expect.objectContaining({ message: "synthetic provider cleanup refused" })],
      });
      expect(siblingClose).not.toHaveBeenCalled();
      activatePluginRegistry(next, null, "gateway-bindable", undefined, owner.registry);
      reload.commit();
    } else if (mode === "timeout") {
      await expect(drain).rejects.toThrow("plugin host cleanup timed out");
      activatePluginRegistry(next, null, "gateway-bindable", undefined, owner.registry);
      reload.commit();
      const fresh = await owner.runtime.getMemorySearchManager({ cfg: config, agentId: "main" });
      assert(fresh.manager, fresh.error ?? "Expected a replacement manager");
      expect(fresh.manager).not.toBe(result.manager);
      await expect(fresh.manager.probeEmbeddingAvailability()).resolves.toMatchObject({ ok: true });
      let joined = false;
      const finalClose = reload.close().then(() => {
        joined = true;
      });
      await Promise.resolve();
      expect(joined).toBe(false);
      releaseClose.resolve();
      await finalClose;
      expect(close).toHaveBeenCalledOnce();
    } else if (mode === "late-probe") {
      await expect(drain).rejects.toThrow("plugin host cleanup timed out");
      activatePluginRegistry(next, null, "gateway-bindable", undefined, owner.registry);
      reload.commit();
      const fresh = await owner.runtime.getMemorySearchManager({ cfg: config, agentId: "main" });
      assert(fresh.manager, fresh.error ?? "Expected a replacement manager");
      expect(fresh.manager).not.toBe(result.manager);
      await expect(fresh.manager.probeEmbeddingAvailability()).resolves.toMatchObject({
        ok: false,
      });
      releaseProbe.resolve();
      await expect(probe).resolves.toMatchObject({ ok: true });
      await expect(reload.close()).resolves.toMatchObject({
        errors: [
          expect.objectContaining({
            message: expect.stringContaining(`Plugin ${targetId} was reloaded or disabled`),
          }),
        ],
      });
      await expect(fresh.manager.probeEmbeddingAvailability()).resolves.toMatchObject({
        ok: false,
        cached: true,
      });
    } else {
      await drain;
      expect(close).toHaveBeenCalledTimes(
        providerClosesBeforeReload + (mode === "unavailable-create" ? 0 : 1),
      );
      activatePluginRegistry(next, null, "gateway-bindable", undefined, owner.registry);
      reload.commit();
    }
    await expect(result.manager.probeEmbeddingAvailability()).rejects.toThrow("closed");
    await expect(other.manager.probeEmbeddingAvailability()).resolves.toMatchObject({ ok: true });
    expect(siblingClose).not.toHaveBeenCalled();
    expect(unaffectedClose).not.toHaveBeenCalled();
    const fresh = await owner.runtime.getMemorySearchManager({ cfg: config, agentId: "main" });
    assert(fresh.manager, fresh.error ?? "Expected a memory manager");
    await expect(fresh.manager.probeEmbeddingAvailability()).resolves.toMatchObject({
      ok: mode !== "late-probe",
    });
    const attemptedCloses = close.mock.calls.length;
    const finalClose = owner.runtime.closeAllMemorySearchManagers?.();
    if (mode === "failed-close" || mode === "late-probe") {
      await expect(finalClose).rejects.toThrow(`Plugin ${targetId} was reloaded or disabled`);
      expect(close).toHaveBeenCalledTimes(attemptedCloses);
    } else {
      await finalClose;
    }
    expect(successorClose).toHaveBeenCalledTimes(mode === "late-probe" ? 0 : 1);
  } finally {
    rejectClose = false;
    releaseCreate.resolve();
    releaseClose.resolve();
    releaseProbe.resolve();
    await Promise.allSettled([probe, drain]);
    // A failed old provider stays behind its revoked admission; join every fixture owner before assertions.
    const memoryCleanup = await Promise.allSettled([
      owner.runtime.closeAllMemorySearchManagers?.(),
      sibling.runtime.closeAllMemorySearchManagers?.(),
      successor.runtime.closeAllMemorySearchManagers?.(),
    ]);
    await disposePluginRegistryInstances(next);
    await disposePluginRegistryInstances(owner.registry);
    await disposePluginRegistryInstances(sibling.registry);
    await disposePluginRegistryInstances(successor.registry);
    await state.cleanup();
    if (mode === "failed-close" || mode === "late-probe") {
      expect(memoryCleanup[0]).toMatchObject({
        status: "rejected",
        reason: expect.objectContaining({
          message: expect.stringContaining(`Plugin ${targetId} was reloaded or disabled`),
        }),
      });
    }
    for (const result of memoryCleanup.slice(
      mode === "failed-close" || mode === "late-probe" ? 1 : 0,
    )) {
      expect(result.status, result.status === "rejected" ? String(result.reason) : undefined).toBe(
        "fulfilled",
      );
    }
  }
  expect(siblingClose).toHaveBeenCalledOnce();
  expect(unaffectedClose).toHaveBeenCalledTimes(mode === "ready" ? 1 : 0);
  expect(successorClose).toHaveBeenCalledTimes(mode === "late-probe" ? 0 : 1);
});

it.each(["legacy-success", "legacy", "modern", "revoked"] as const)(
  "reports admitted memory cleanup failures and preserves admission guards (%s)",
  async (mode) => {
    const owner = registerMemoryOwner({});
    const failure = new Error("memory callback cleanup failed");
    const close = vi.fn(async () => {
      expect(getPluginRuntimeGatewayRequestScope()?.pluginRegistry).toBe(owner.registry);
      if (mode !== "legacy-success") {
        throw failure;
      }
    });
    const runtime: MemoryPluginRuntime = {
      getMemorySearchManager: async () => ({ manager: null }),
      resolveMemoryBackendConfig: () => ({ backend: "builtin" }),
      ...(mode === "modern"
        ? { prepareReload: () => ({ drain: close, resume() {} }) }
        : { closeAllMemorySearchManagers: close }),
    };
    owner.registry.memoryCapabilities[0]!.capability = owner.instance.wrap({ runtime });
    const prepared = prepareMemoryRuntimeReload(owner.registry, createEmptyPluginRegistry());
    owner.instance.quiesce();
    try {
      if (mode === "revoked") {
        await owner.instance.dispose();
        await expect(prepared.drain()).rejects.toThrow("retiring");
        expect(close).not.toHaveBeenCalled();
      } else {
        const errors = mode === "legacy-success" ? [] : [failure];
        await expect(prepared.drain()).resolves.toEqual({ errors });
        await expect(prepared.close()).resolves.toEqual({ errors });
        prepared.commit();
        expect(close).toHaveBeenCalledOnce();
      }
    } finally {
      await disposePluginRegistryInstances(owner.registry);
    }
  },
);

it("unwinds prepared memory admission when another runtime rejects preparation", async () => {
  const first = registerMemoryOwner({});
  const next = createEmptyPluginRegistry();
  const resume = vi.fn();
  const drain = vi.fn(async () => {});
  const failure = new Error("second memory runtime preparation failed");
  const firstRuntime = first.instance.wrap({
    ...memoryRuntime,
    prepareReload: () => ({ drain, resume }),
  });
  first.registry.memoryCapabilities[0]!.capability = first.instance.wrap({ runtime: firstRuntime });
  first.registry.memoryCapabilities.push({
    pluginId: "another-runtime",
    capability: {
      runtime: {
        ...memoryRuntime,
        prepareReload() {
          throw failure;
        },
      },
    },
  });
  try {
    expect(() => prepareMemoryRuntimeReload(first.registry, next)).toThrow(failure);
    expect(resume).toHaveBeenCalledOnce();
    expect(drain).not.toHaveBeenCalled();
  } finally {
    await disposePluginRegistryInstances(first.registry);
  }
});

it("fences runtime acquisition before its first manager and resumes only on rollback", async () => {
  const state = await createOpenClawTestState({ scenario: "minimal", label: "memory-lazy-reload" });
  const config: OpenClawConfig = {
    plugins: { enabled: false },
    agents: { defaults: { workspace: state.workspaceDir } },
    memory: {
      search: {
        provider: "none",
        store: { vector: { enabled: false } },
      },
    },
  };
  const owner = registerMemoryOwner(config);
  try {
    const older = prepareMemoryRuntimeReload(owner.registry, createEmptyPluginRegistry());
    const reload = prepareMemoryRuntimeReload(owner.registry, createEmptyPluginRegistry());
    await reload.drain();
    older.rollback();
    expect(
      await owner.runtime.getMemorySearchManager({ cfg: config, agentId: "main" }),
    ).toMatchObject({ manager: null, error: expect.stringContaining("reloading") });
    reload.rollback();
    const acquired = await owner.runtime.getMemorySearchManager({ cfg: config, agentId: "main" });
    assert(acquired.manager, acquired.error ?? "Expected a memory manager");
    const retiring = prepareMemoryRuntimeReload(owner.registry, createEmptyPluginRegistry());
    await retiring.close();
    retiring.commit();
    expect(
      await owner.runtime.getMemorySearchManager({ cfg: config, agentId: "main" }),
    ).toMatchObject({ manager: null, error: expect.stringContaining("reloading") });
  } finally {
    await owner.runtime.closeAllMemorySearchManagers?.();
    await disposePluginRegistryInstances(owner.registry);
    await state.cleanup();
  }
});
