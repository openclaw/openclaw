import assert from "node:assert/strict";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createOpenClawTestState as createState } from "../test-utils/openclaw-test-state.js";
import type { EmbeddingProviderAdapter } from "./embedding-provider-types.js";
import { createPluginRecord } from "./loader-records.js";
import { activatePluginRegistry } from "./loader-shared.js";
import { prepareMemoryRuntimeReload as prepareReload } from "./memory-runtime.js";
import { getPluginInstance } from "./plugin-instance-scope.js";
import type { MemoryPluginRuntime } from "./registry-contribution-types.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { createTestPluginRegistry } from "./registry-runtime.test-helpers.js";
import { disposePluginRegistryInstances as disposeRegistry } from "./runtime.js";
import { getPluginRuntimeGatewayRequestScope as currentScope } from "./runtime/gateway-request-scope.js";

const cleanupClock = vi.hoisted(() => ({ setTimeout: globalThis.setTimeout }));
const fixture = {
  source: "fixture",
  origin: "config",
  enabled: true,
  configSchema: false,
} as const;

beforeEach(() => {
  const nativeSetTimeout = globalThis.setTimeout;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldClearNativeTimers: true });
  cleanupClock.setTimeout = globalThis.setTimeout;
  globalThis.setTimeout = nativeSetTimeout;
});
afterEach(() => vi.useRealTimers());

vi.mock("./host-hook-cleanup-timeout.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./host-hook-cleanup-timeout.js")>();
  return {
    ...actual,
    withPluginHostCleanupTimeout: <T>(hookId: string, cleanup: () => T | Promise<T>) => {
      const nativeSetTimeout = globalThis.setTimeout;
      // Only the cleanup deadline is virtual; asynchronous workers and watchers keep real timers.
      globalThis.setTimeout = cleanupClock.setTimeout;
      try {
        return actual.withPluginHostCleanupTimeout(hookId, cleanup, 500);
      } finally {
        globalThis.setTimeout = nativeSetTimeout;
      }
    },
  };
});

const { createMemoryRuntime } = await vi.importActual<{
  createMemoryRuntime: (host: {
    runInBackgroundContext: <T>(run: () => T) => T;
  }) => MemoryPluginRuntime;
}>("../../extensions/memory-core/runtime-api.js");

function memoryConfig(
  workspace: string,
  search: NonNullable<OpenClawConfig["memory"]>["search"],
): OpenClawConfig {
  return {
    plugins: { enabled: false },
    agents: { defaults: { workspace } },
    memory: { search: { store: { vector: { enabled: false } }, ...search } },
  };
}

function embeddingProvider(id: string, close: () => Promise<void>, embed = async () => [1, 0, 0]) {
  return { id, model: "synthetic-embedding", embed, embedBatch: async () => [[1, 0, 0]], close };
}

async function getManager(
  owner: ReturnType<typeof registerMemoryOwner>,
  cfg: OpenClawConfig,
  overrides: Partial<Parameters<MemoryPluginRuntime["getMemorySearchManager"]>[0]> = {},
) {
  const result = await owner.runtime.getMemorySearchManager({ cfg, agentId: "main", ...overrides });
  assert(result.manager, result.error ?? "Expected a memory manager");
  return result.manager;
}

async function expectAvailable(manager: Awaited<ReturnType<typeof getManager>>, ok = true) {
  await expect(manager.probeEmbeddingAvailability()).resolves.toMatchObject({ ok });
}

function registerMemoryOwner(config: OpenClawConfig, options: { legacy?: boolean } = {}) {
  const owner = createTestPluginRegistry();
  const record = createPluginRecord({ ...fixture, id: "memory-fixture" });
  record.kind = "memory";
  record.memorySlotSelected = true;
  owner.registry.plugins.push(record);
  const api = owner.createApi(record, { config });
  assert(api.lifecycle.runInBackgroundContext);
  const runtimeImplementation = createMemoryRuntime({
    runInBackgroundContext: api.lifecycle.runInBackgroundContext,
  });
  if (options.legacy) {
    delete runtimeImplementation.prepareReload;
  }
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
  const { id } = adapter;
  const record = createPluginRecord({ ...fixture, id, contracts: { embeddingProviders: [id] } });
  owner.registry.plugins.push(record);
  owner.createApi(record, { config }).registerEmbeddingProvider(adapter);
  return { record, registration: owner.registry.embeddingProviders.at(-1)! };
}

it.each([
  "ready",
  "legacy-retained",
  "pending-primary",
  "pending-fallback",
  "unavailable-create",
  "failed-close",
  "timeout",
  "late-probe",
  "transient",
] as const)("drains the actual managed embedding owner before replacement (%s)", async (mode) => {
  const state = await createState({ scenario: "minimal", label: "memory-provider-reload" });
  const fallback = mode === "pending-fallback";
  const providerId = fallback ? "primary-probe" : "embedding-probe";
  const targetId = fallback ? "fallback-probe" : providerId;
  const revoked = mode === "failed-close" || mode === "late-probe";
  const timedOut = mode === "timeout" || mode === "late-probe";
  const revokedMessage = `Plugin ${targetId} was reloaded or disabled`;
  const config = memoryConfig(state.workspaceDir, {
    provider: providerId,
    model: "synthetic-embedding",
    fallback: fallback ? targetId : "none",
  });
  const owner = registerMemoryOwner(config, { legacy: mode === "legacy-retained" });
  const sibling = registerMemoryOwner(config);
  const successor = registerMemoryOwner(config);
  const entered = createDeferredCore();
  const releaseCreate = createDeferredCore();
  const releaseClose = createDeferredCore();
  const closeEntered = createDeferredCore();
  const probeEntered = createDeferredCore();
  const releaseProbe = createDeferredCore();
  let rejectClose = mode === "failed-close";
  const embed = vi.fn(async () => {
    probeEntered.resolve();
    if (mode === "late-probe") {
      await releaseProbe.promise;
    }
    return [1, 0, 0];
  });
  const create = vi.fn(async () => {
    entered.resolve();
    if (mode === "unavailable-create") {
      return { provider: null };
    }
    if (mode.startsWith("pending")) {
      await releaseCreate.promise;
    }
    return { provider: embeddingProvider(targetId, close, embed) };
  });
  const close = vi.fn(async () => {
    closeEntered.resolve();
    expect(currentScope()?.pluginId).toBe(targetId);
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
    create: async () => ({ provider: embeddingProvider(providerId, siblingClose) }),
  });
  const successorClose = vi.fn(async () => {});
  const successorCreate = vi.fn(async () => ({
    provider: mode === "late-probe" ? null : embeddingProvider(targetId, successorClose),
  }));
  const replacement = registerAdapter(successor, config, {
    id: targetId,
    create: successorCreate,
  });
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
  let lateManager: Awaited<ReturnType<typeof getManager>> | undefined;
  // Each live replacement-era manager (fresh main, fenced late) owns one successor provider.
  const successorProviders = () => (mode === "late-probe" ? 0 : lateManager ? 2 : 1);
  let drain: ReturnType<ReturnType<typeof prepareReload>["drain"]> | undefined;
  try {
    const manager = await getManager(owner, config, mode === "transient" ? { purpose: "cli" } : {});
    const other = await getManager(sibling, config);
    await other.probeEmbeddingAvailability();
    probe = manager.probeEmbeddingAvailability();
    await entered.promise;
    if (mode === "late-probe") {
      await probeEntered.promise;
    } else if (!mode.startsWith("pending")) {
      await probe;
    }
    if (mode === "legacy-retained") {
      const unchanged = prepareReload(owner.registry, owner.registry);
      await unchanged.drain();
      unchanged.commit();
      expect(close).not.toHaveBeenCalled();
    }
    const reload = prepareReload(owner.registry, next);
    const drained = vi.fn();
    drain = reload.drain().finally(drained);
    if (mode.startsWith("pending")) {
      await Promise.resolve();
      expect(drained).not.toHaveBeenCalled();
      expect(close).not.toHaveBeenCalled();
    }
    if (mode !== "legacy-retained") {
      // Only prepareReload declares an admission fence for concurrent acquisition.
      const creationsBeforeLateAcquisition = create.mock.calls.length;
      lateManager = await getManager(owner, config, { agentId: "late" });
      await expect(lateManager.probeEmbeddingAvailability()).rejects.toThrow("reloading");
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
    } else if (timedOut) {
      const expired = expect(drain).rejects.toThrow("plugin host cleanup timed out");
      if (mode === "timeout") {
        await closeEntered.promise;
      }
      await vi.advanceTimersByTimeAsync(500);
      await expired;
    } else {
      await drain;
      expect(close).toHaveBeenCalledTimes(mode === "unavailable-create" ? 0 : 1);
    }
    activatePluginRegistry(next, null, "gateway-bindable", undefined, owner.registry);
    reload.commit();
    if (timedOut) {
      const fresh = await getManager(owner, config);
      expect(fresh).not.toBe(manager);
      await expectAvailable(fresh, mode !== "late-probe");
      if (mode === "timeout") {
        const joined = vi.fn();
        const finalClose = reload.close().then(joined);
        await Promise.resolve();
        expect(joined).not.toHaveBeenCalled();
        releaseClose.resolve();
        await finalClose;
        expect(close).toHaveBeenCalledOnce();
      } else {
        releaseProbe.resolve();
        await expect(probe).resolves.toMatchObject({ ok: true });
        await expect(reload.close()).resolves.toMatchObject({
          errors: [expect.objectContaining({ message: `Plugin ${targetId} is retiring` })],
        });
      }
    }
    await expect(manager.probeEmbeddingAvailability()).rejects.toThrow("closed");
    await expectAvailable(other);
    expect(siblingClose).not.toHaveBeenCalled();
    const fresh = await getManager(owner, config);
    if (mode === "late-probe") {
      await expect(fresh.search("replacement provider required")).rejects.toThrow(
        'Memory search unavailable: embedding provider "embedding-probe" is configured but unavailable.',
      );
    } else {
      if (mode.startsWith("pending")) {
        await expect(fresh.search("replacement provider acquisition")).resolves.toEqual([]);
      }
      await expectAvailable(fresh);
    }
    // A real search acquires each required successor provider, unlike advisory cached probes.
    if (lateManager) {
      if (mode.startsWith("pending")) {
        await expect(lateManager.search("replacement provider acquisition")).resolves.toEqual([]);
      }
      await expectAvailable(lateManager, mode !== "late-probe");
    }
    if (mode.startsWith("pending")) {
      expect(successorCreate).toHaveBeenCalledTimes(2);
    }
    const attemptedCloses = close.mock.calls.length;
    const finalClose = owner.runtime.closeAllMemorySearchManagers?.();
    if (revoked) {
      await expect(finalClose).rejects.toThrow(revokedMessage);
      expect(close).toHaveBeenCalledTimes(attemptedCloses);
    } else {
      await finalClose;
    }
    if (mode === "ready") {
      expect(other.status().sources).toBeDefined();
      await expect(other.search("sibling still live")).resolves.toEqual([]);
    }
    expect(successorClose).toHaveBeenCalledTimes(successorProviders());
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
    for (const registry of [next, owner.registry, sibling.registry, successor.registry]) {
      await disposeRegistry(registry);
    }
    await state.cleanup();
    if (revoked) {
      expect(memoryCleanup[0]).toMatchObject({
        status: "rejected",
        reason: { message: expect.stringContaining(revokedMessage) },
      });
    }
    for (const result of memoryCleanup.slice(revoked ? 1 : 0)) {
      expect(result.status, result.status === "rejected" ? String(result.reason) : undefined).toBe(
        "fulfilled",
      );
    }
  }
  expect(siblingClose).toHaveBeenCalledOnce();
  expect(successorClose).toHaveBeenCalledTimes(successorProviders());
});

it.each(["legacy-success", "legacy", "modern", "revoked"] as const)(
  "reports admitted memory cleanup failures and preserves admission guards (%s)",
  async (mode) => {
    const owner = registerMemoryOwner({});
    const failure = new Error("memory callback cleanup failed");
    const close = vi.fn(async () => {
      expect(currentScope()?.pluginRegistry).toBe(owner.registry);
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
    const prepared = prepareReload(owner.registry, createEmptyPluginRegistry());
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
      await disposeRegistry(owner.registry);
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
    ...first.runtime,
    prepareReload: () => ({ drain, resume }),
  });
  first.registry.memoryCapabilities[0]!.capability = first.instance.wrap({ runtime: firstRuntime });
  first.registry.memoryCapabilities.push({
    pluginId: "another-runtime",
    capability: {
      runtime: {
        ...first.runtime,
        prepareReload() {
          throw failure;
        },
      },
    },
  });
  try {
    expect(() => prepareReload(first.registry, next)).toThrow(failure);
    expect(resume).toHaveBeenCalledOnce();
    expect(drain).not.toHaveBeenCalled();
  } finally {
    await disposeRegistry(first.registry);
  }
});
