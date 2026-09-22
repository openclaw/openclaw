import assert from "node:assert/strict";
import { expect, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getMemoryEmbeddingProvider } from "../plugins/memory-embedding-provider-runtime.js";
import { PluginInstanceUnavailableError } from "../plugins/plugin-instance-error.js";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import type { MemoryPluginRuntime } from "../plugins/registry-contribution-types.js";
import { createPluginRegistry } from "../plugins/registry.js";
import { disposePluginRegistryInstances } from "../plugins/runtime.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveRelativeBundledPluginPublicModuleId } from "../test-utils/bundled-plugin-public-surface.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { createPluginReloadRecoveryFixture } from "./server-plugin-reload.recovery.test-support.js";

const { memoryRuntime } = await vi.importActual<{ memoryRuntime: MemoryPluginRuntime }>(
  resolveRelativeBundledPluginPublicModuleId({
    fromModuleUrl: import.meta.url,
    pluginId: "memory-core",
    artifactBasename: "runtime-api.js",
  }),
);

export async function verifyGatewayMemoryReplacement(
  createRecoveryFixture: (
    options: Parameters<typeof createPluginReloadRecoveryFixture>[1],
  ) => ReturnType<typeof createPluginReloadRecoveryFixture>,
  mode: "held-close" | "failed-close",
) {
  const state = await createOpenClawTestState({
    scenario: "minimal",
    label: "gateway-memory-reload",
  });
  const providerId = "gateway-memory-probe";
  const config: OpenClawConfig = {
    plugins: { allow: ["first", "sibling"], slots: { memory: "sibling" } },
    agents: { defaults: { workspace: state.workspaceDir } },
    memory: {
      search: {
        provider: providerId,
        model: "synthetic-embedding",
        fallback: "none",
        store: { vector: { enabled: false } },
      },
    },
  };
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const events: string[] = [];
  let refuseClose = mode === "failed-close";
  let generations = 0;
  const created: number[] = [];
  const embedding = (close: () => Promise<void>) => ({
    id: providerId,
    model: "synthetic-embedding",
    embed: async () => [1, 0, 0],
    embedBatch: async () => [[1, 0, 0]],
    close,
  });
  const close = vi.fn(async () => {
    const instance = getPluginInstance(fixture.previousRegistry.plugins[0]!);
    expect(instance?.lifecycle.signal.aborted).toBe(false);
    expect(getPluginRuntimeGatewayRequestScope()?.pluginId).toBe("first");
    events.push("close:start");
    entered.resolve();
    if (refuseClose) {
      throw new Error("memory provider cleanup refused");
    }
    if (mode === "held-close") {
      await release.promise;
    }
    events.push("close:end");
  });
  const fixture = await createRecoveryFixture({
    config,
    abortOnCandidateStart: false,
    register(api, owner, record) {
      if (owner === "sibling") {
        record.kind = "memory";
        record.memorySlotSelected = true;
        api.registerMemoryCapability({ runtime: memoryRuntime });
      } else {
        record.contracts = { ...record.contracts, embeddingProviders: [providerId] };
        const generation = ++generations;
        api.registerEmbeddingProvider({
          id: providerId,
          create: async () => {
            created.push(generation);
            return { provider: embedding(generation === 1 ? close : async () => {}) };
          },
        });
      }
    },
    beforePublish: async () => {
      if (mode === "held-close") {
        expect(events.at(-1)).toBe("close:end");
      }
      events.push("publish");
    },
  });
  const runtime = fixture.previousRegistry.memoryCapabilities[0]?.capability.runtime;
  assert(runtime);
  const independent = createPluginRegistry({
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    runtime: {} as PluginRuntime,
    activateGlobalSideEffects: false,
  });
  const otherRecord = createPluginRecord({ id: "other-memory-host" });
  otherRecord.kind = "memory";
  otherRecord.memorySlotSelected = true;
  otherRecord.contracts = { embeddingProviders: [providerId] };
  independent.registry.plugins.push(otherRecord);
  const otherApi = independent.createApi(otherRecord, { config });
  otherApi.registerMemoryCapability({ runtime: memoryRuntime });
  const otherClose = vi.fn(async () => {});
  otherApi.registerEmbeddingProvider({
    id: providerId,
    create: async () => ({ provider: embedding(otherClose) }),
  });
  const otherRuntime = independent.registry.memoryCapabilities[0]?.capability.runtime;
  assert(otherRuntime);
  let reloading: Promise<unknown> | undefined;
  try {
    const memoryInstance = getPluginInstance(fixture.previousRegistry.plugins[1]!);
    assert(memoryInstance);
    expect(memoryInstance.run(() => getMemoryEmbeddingProvider(providerId, config))).toBe(
      fixture.previousRegistry.embeddingProviders[0]?.provider,
    );
    const old = await runtime.getMemorySearchManager({ cfg: config, agentId: "main" });
    const other = await otherRuntime.getMemorySearchManager({ cfg: config, agentId: "main" });
    assert(old.manager, old.error ?? "Expected a memory manager");
    assert(other.manager, other.error ?? "Expected an independent memory manager");
    await old.manager.probeEmbeddingAvailability();
    await other.manager.probeEmbeddingAvailability();
    expect(created).toEqual([1]);
    reloading = fixture.reload().catch((error: unknown) => error);
    // The pre-fix Gateway can finish without entering memory cleanup; race that
    // outcome so its missing owner produces an assertion rather than a deadlock.
    await Promise.race([
      entered.promise,
      reloading.then(() => expect(close).toHaveBeenCalledOnce()),
    ]);
    expect(otherClose).not.toHaveBeenCalled();
    if (mode === "failed-close") {
      expect(await reloading).toMatchObject({
        runtime: {
          pluginIds: ["first"],
          warnings: [expect.stringContaining("memory provider cleanup refused")],
        },
      });
      expect(close).toHaveBeenCalled();
      reloading = fixture.reload();
    } else {
      expect(fixture.registryOwner.registry).toBe(fixture.previousRegistry);
      expect(fixture.firstStop).not.toHaveBeenCalled();
      expect(events).toEqual(["close:start"]);
      release.resolve();
    }
    expect(await reloading).toMatchObject({ runtime: { pluginIds: ["first"] } });
    if (mode === "held-close") {
      expect(events.slice(-2)).toEqual(["close:end", "publish"]);
      expect(close).toHaveBeenCalledOnce();
    }
    expect(getPluginInstance(fixture.previousRegistry.plugins[0]!)?.lifecycle.signal.aborted).toBe(
      true,
    );
    await expect(old.manager.probeEmbeddingAvailability()).rejects.toThrow("closed");
    expect(fixture.registryOwner.registry.memoryCapabilities[0]?.capability.runtime).toBe(runtime);
    const fresh = await runtime.getMemorySearchManager({ cfg: config, agentId: "main" });
    assert(fresh.manager, fresh.error ?? "Expected a replacement memory manager");
    await expect(fresh.manager.probeEmbeddingAvailability()).resolves.toMatchObject({ ok: true });
    expect(created).toEqual([1, generations]);
    await expect(other.manager.probeEmbeddingAvailability()).resolves.toMatchObject({ ok: true });
    expect(otherClose).not.toHaveBeenCalled();
    expect(fixture.siblingStop).not.toHaveBeenCalled();
    expect(fixture.siblingStart).toHaveBeenCalledOnce();
  } finally {
    refuseClose = false;
    release.resolve();
    await Promise.allSettled([reloading]);
    const closeCalls = close.mock.calls.length;
    try {
      const closing = runtime.closeAllMemorySearchManagers?.();
      if (mode === "failed-close") {
        await expect(closing).rejects.toThrow(PluginInstanceUnavailableError);
        await expect(closing).rejects.toThrow(
          "Plugin first was reloaded or disabled; use its current tools.",
        );
      } else {
        await expect(closing).resolves.toBeUndefined();
      }
      expect(close).toHaveBeenCalledTimes(closeCalls);
    } finally {
      try {
        await otherRuntime.closeAllMemorySearchManagers?.();
      } finally {
        try {
          await disposePluginRegistryInstances(independent.registry);
        } finally {
          await state.cleanup();
        }
      }
    }
  }
}
