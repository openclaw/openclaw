import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, vi } from "vitest";
import {
  buildFileEntry,
  buildMultimodalChunkForIndexing,
  listMemoryFiles,
} from "../../packages/memory-host-sdk/src/host/internal.js";
import { readMemoryFile } from "../../packages/memory-host-sdk/src/host/read-file.js";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { registerAgentWorkspaceAccess } from "../agents/workspace-access.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getMemoryEmbeddingProvider } from "../plugins/memory-embedding-provider-runtime.js";
import { PluginInstanceUnavailableError } from "../plugins/plugin-instance-error.js";
import { getPluginInstance, getPluginOriginalValue } from "../plugins/plugin-instance-scope.js";
import type {
  MemoryPluginRuntime,
  RegisteredMemorySearchManager,
} from "../plugins/registry-contribution-types.js";
import { createPluginRegistry } from "../plugins/registry.js";
import { disposePluginRegistryInstances } from "../plugins/runtime.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeRegistryScope,
} from "../plugins/runtime/gateway-request-scope.js";
import { createPluginRuntime } from "../plugins/runtime/index.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import type { OpenClawPluginApi } from "../plugins/types.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveRelativeBundledPluginPublicModuleId } from "../test-utils/bundled-plugin-public-surface.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { createPluginReloadRecoveryFixture } from "./server-plugin-reload.recovery.test-support.js";

const { createMemoryRuntime, configureMemoryCoreDreamingState } = await vi.importActual<{
  configureMemoryCoreDreamingState: (
    open: OpenClawPluginApi["runtime"]["state"]["openKeyedStore"],
  ) => void;
  createMemoryRuntime: (host: {
    runInBackgroundContext: <T>(run: () => T) => T;
  }) => MemoryPluginRuntime;
}>(
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
        assert(api.lifecycle.runInBackgroundContext);
        api.registerMemoryCapability({
          runtime: createMemoryRuntime({
            runInBackgroundContext: api.lifecycle.runInBackgroundContext,
          }),
        });
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
    runtime: createPluginRuntime(),
    activateGlobalSideEffects: false,
  });
  const otherRecord = createPluginRecord({ id: "other-memory-host" });
  otherRecord.kind = "memory";
  otherRecord.memorySlotSelected = true;
  otherRecord.contracts = { embeddingProviders: [providerId] };
  independent.registry.plugins.push(otherRecord);
  const otherApi = independent.createApi(otherRecord, { config });
  assert(otherApi.lifecycle.runInBackgroundContext);
  otherApi.registerMemoryCapability({
    runtime: createMemoryRuntime({
      runInBackgroundContext: otherApi.lifecycle.runInBackgroundContext,
    }),
  });
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
    expect(fixture.siblingStop).toHaveBeenCalledTimes(generations - 1);
    expect(fixture.siblingStart).toHaveBeenCalledTimes(generations);
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

export async function verifyGatewayMemoryWatcherRestart(
  createRecoveryFixture: (
    options: Parameters<typeof createPluginReloadRecoveryFixture>[1],
  ) => ReturnType<typeof createPluginReloadRecoveryFixture>,
  providerState: "pending" | "initialized" | "separate-registry" | "rollback",
  signal: AbortSignal,
  recovery?: {
    owner: "retained" | "replaced";
    failure: "before-drain" | "checkpoint" | "restart";
  },
) {
  const state = await createOpenClawTestState({ label: "gateway-memory-watcher-reload" });
  const config: OpenClawConfig = {
    plugins: { allow: ["first", "sibling"], slots: { memory: "sibling" } },
    agents: { defaults: { workspace: state.workspaceDir } },
    memory: {
      search: {
        provider: "gateway-memory-probe",
        model: "synthetic",
        fallback: "none",
        sources: ["memory"],
        cache: { enabled: false },
        store: { vector: { enabled: false } },
      },
    },
  };
  const subscriptions: Array<{ notify: () => void; signal: AbortSignal }> = [];
  const unused = async (): Promise<never> => {
    throw new Error("Unexpected document operation");
  };
  const releaseWorkspace = registerAgentWorkspaceAccess(state.workspaceDir, {
    bridge: { readFile: unused, writeFile: unused, stat: unused },
    memoryFiles: {
      assertCurrent() {},
      listFiles: listMemoryFiles,
      inspectFile: buildFileEntry,
      readFile: readMemoryFile,
      buildMultimodalChunk: buildMultimodalChunkForIndexing,
      readForIndexing: async (file) => ({
        content: await fs.readFile(file, "utf8"),
        canonicalRelativePath: path.relative(state.workspaceDir, file),
      }),
      watch: async (_request, onChange, watchSignal) => {
        subscriptions.push({
          notify: AsyncLocalStorage.bind(() => onChange("change")),
          signal: watchSignal,
        });
        await new Promise<void>((resolve) => {
          watchSignal.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    },
  });
  const managers: RegisteredMemorySearchManager[] = [];
  const embeddings: number[] = [];
  let generation = 0;
  let memory: MemoryPluginRuntime | undefined;
  const restarted = createDeferredCore();
  const releaseStartup = createDeferredCore();
  let reloading: Promise<unknown> | undefined;
  let independent: ReturnType<typeof createPluginRegistry> | undefined;
  const recoveryFailure = new Error("memory reload checkpoint failed");
  const registerProvider = (api: OpenClawPluginApi, current: number) =>
    api.registerEmbeddingProvider({
      id: "gateway-memory-probe",
      create: async () => ({
        provider: {
          id: "gateway-memory-probe",
          model: "synthetic",
          embed: async () => {
            embeddings.push(current);
            return [1, 0];
          },
          embedBatch: async (texts) => {
            embeddings.push(current);
            return texts.map(() => [1, 0]);
          },
        },
      }),
    });
  try {
    const fixture = await createRecoveryFixture({
      config,
      abortOnCandidateStart: providerState === "rollback",
      checkpoint: async () => {
        if (recovery && recovery.failure !== "before-drain" && subscriptions[0]?.signal.aborted) {
          throw recoveryFailure;
        }
      },
      beforePublish: async () => {
        expect(
          subscriptions[0]!.signal.aborted,
          "Stop memory watchers before provider publication",
        ).toBe(true);
        if (independent) {
          await disposePluginRegistryInstances(independent.registry);
        }
      },
      register(api, owner, record) {
        if (owner === "first") {
          record.contracts = { embeddingProviders: ["gateway-memory-probe"] };
          registerProvider(api, ++generation);
          return;
        }
        record.kind = "memory";
        record.memorySlotSelected = true;
        assert(api.lifecycle.runInBackgroundContext);
        const runtime = createMemoryRuntime({
          runInBackgroundContext: api.lifecycle.runInBackgroundContext,
        });
        getPluginInstance(record)!.run(() =>
          configureMemoryCoreDreamingState((options) => api.runtime.state.openKeyedStore(options)),
        );
        api.registerMemoryCapability({ runtime });
        api.registerService({
          id: "memory-index",
          async start({ config: cfg }) {
            const opened = await runtime.getMemorySearchManager({ cfg, agentId: "main" });
            assert(opened.manager, opened.error ?? "Expected a memory manager");
            managers.push(opened.manager);
            if (managers.length > 1) {
              restarted.resolve();
              await releaseStartup.promise;
              if (recovery?.failure === "restart") {
                throw new Error("memory indexing restart failed");
              }
            }
          },
          stop: () => runtime.closeAllMemorySearchManagers?.(),
        });
      },
    });
    memory = fixture.previousRegistry.memoryCapabilities[0]?.capability.runtime;
    if (recovery?.failure === "before-drain") {
      fixture.lifetime.publish({
        stop: async () => {},
        preparePluginReload: () => ({
          drain: async () => {
            throw recoveryFailure;
          },
          resume() {},
        }),
      });
    }
    expect(subscriptions).toHaveLength(1);
    const first = managers[0]!;
    if (providerState === "separate-registry") {
      independent = createPluginRegistry({
        logger: { info() {}, warn() {}, error() {}, debug() {} },
        runtime: createPluginRuntime(),
        activateGlobalSideEffects: false,
      });
      const record = createPluginRecord({
        id: "lazy-provider",
        contracts: { embeddingProviders: ["gateway-memory-probe"] },
      });
      independent.registry.plugins.push(record);
      registerProvider(independent.createApi(record, { config }), 0);
      await withPluginRuntimeRegistryScope(
        {
          ...fixture.previousRegistry,
          embeddingProviders: independent.registry.embeddingProviders,
        },
        () => first.probeEmbeddingAvailability(),
      );
    } else if (providerState !== "pending") {
      await first.probeEmbeddingAvailability();
    }
    expect(embeddings).toEqual(
      providerState === "pending" ? [] : [providerState === "separate-registry" ? 0 : 1],
    );
    embeddings.length = 0;
    const instance = getPluginInstance(fixture.previousRegistry.plugins[1]!);
    assert(instance);
    const original = getPluginOriginalValue(first, instance) ?? first;
    const prototype = Object.getPrototypeOf(original) as RegisteredMemorySearchManager;
    const sync = prototype.sync;
    assert(sync);
    const indexed = createDeferredCore<number | undefined>();
    const observer = vi.spyOn(prototype, "sync").mockImplementation(function (
      this: RegisteredMemorySearchManager,
      params,
    ) {
      const work = sync.call(this, params);
      if (params?.reason === "watch") {
        indexed.resolve(work.then(() => this.status().chunks));
      }
      return work;
    });
    reloading = fixture
      .reload(config, [recovery?.owner === "replaced" ? "sibling" : "first"])
      .catch((error: unknown) => error);
    if (recovery?.failure === "before-drain") {
      releaseStartup.resolve();
    } else {
      await withinTest(
        awaitGateBeforeSettlement(
          restarted.promise,
          reloading,
          "Plugin reload completed without restarting drained memory indexing",
        ),
        signal,
      );
      expect(subscriptions[0]!.signal.aborted).toBe(true);
      let settled = false;
      void reloading.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled, "Reload must join memory service startup").toBe(false);
      expect(fixture.owner.getReloadStatus()).toMatchObject({
        phase: providerState === "rollback" ? "recovering" : "reloading",
      });
      releaseStartup.resolve();
    }
    expect(fixture.registryOwner.registry.memoryCapabilities[0]?.capability.runtime).toBe(
      fixture.previousRegistry.memoryCapabilities[0]?.capability.runtime,
    );
    const result = await reloading;
    if (providerState === "rollback" || recovery) {
      expect(result).toMatchObject({ details: { committed: false } });
    } else {
      expect(result).toMatchObject({ runtime: { pluginIds: ["first"] } });
    }
    if (recovery?.failure === "restart") {
      expect(result).toMatchObject({
        cause: {
          errors: [
            recoveryFailure,
            expect.objectContaining({ message: "plugin services failed to start" }),
          ],
        },
      });
      expect(fixture.owner.getReloadStatus()).toMatchObject({ phase: "failed" });
      expect(subscriptions.every((subscription) => subscription.signal.aborted)).toBe(true);
      return;
    }
    expect(fixture.owner.getReloadStatus()).toBeUndefined();
    if (recovery) {
      expect(result).toMatchObject({ cause: recoveryFailure });
      expect(fixture.registryOwner.registry).toBe(fixture.previousRegistry);
      expect(fixture.firstStop).not.toHaveBeenCalled();
    }
    expect(subscriptions).toHaveLength(recovery?.failure === "before-drain" ? 1 : 2);
    if (providerState === "initialized" && !recovery) {
      await fixture.reload();
      expect(subscriptions).toHaveLength(3);
    }
    expect(subscriptions.slice(0, -1).every((subscription) => subscription.signal.aborted)).toBe(
      true,
    );
    expect(managers.at(-1)!.status().chunks).toBe(0);
    await fs.mkdir(path.join(state.workspaceDir, "memory"), { recursive: true });
    await fs.writeFile(
      path.join(state.workspaceDir, "memory", "after-provider-reload.md"),
      "Violet cranes nest beside the lagoon.",
    );
    for (const subscription of subscriptions.slice(0, -1)) {
      subscription.notify();
    }
    expect(observer).not.toHaveBeenCalled();
    subscriptions.at(-1)!.notify();
    expect(await withinTest(indexed.promise, signal)).toBeGreaterThan(0);
    expect(embeddings).toEqual([generation]);
  } finally {
    releaseStartup.resolve();
    await Promise.allSettled([reloading]);
    await memory?.closeAllMemorySearchManagers?.();
    if (independent) {
      await disposePluginRegistryInstances(independent.registry);
    }
    vi.restoreAllMocks();
    releaseWorkspace();
    await state.cleanup();
  }
}
