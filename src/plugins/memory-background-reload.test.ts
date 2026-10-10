import "../test-utils/prepare-compiled-subprocesses.js";
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import type { MemoryWorkspaceFiles } from "../../packages/memory-host-sdk/src/host/workspace-files.js";
import { withinTest } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  createLazyPluginRuntime,
  createPluginModuleLoader,
  runPluginRegisterSyncInRegistry,
} from "./loader-module-runtime.js";
import { tryNativeRequireModule } from "./native-module-require.js";
import { bindPluginInstanceModuleLoader } from "./plugin-instance-module-loader.js";
import { getPluginInstance, getPluginOriginalValue } from "./plugin-instance-scope.js";
import type { PluginInstance } from "./plugin-instance.js";
import type { RegisteredMemorySearchManager } from "./registry-contribution-types.js";
import { adoptPluginRegistryRecords } from "./registry-lifecycle.js";
import { createPluginRegistry } from "./registry.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "./runtime/gateway-request-scope.js";
import { preparePluginLoaderAliases } from "./sdk-alias.js";
import { createPluginRecord } from "./status.test-helpers.js";
import type { OpenClawPluginDefinition } from "./types.js";

const repository = fileURLToPath(new URL("../..", import.meta.url));
const loadHost = createPluginModuleLoader({
  devSourceRoot: repository,
  pluginSdkResolution: "src",
});
const memorySource = path.join(repository, "extensions/memory-core/index.ts");
const openingTurn = new AsyncLocalStorage<string>();
const logger = { info() {}, warn() {}, error() {}, debug() {} };
const providerId = "background-reload-fixture";
const { createOpenClawTestState } = loadHost(
  path.join(repository, "src/test-utils/openclaw-test-state.ts"),
) as typeof import("../test-utils/openclaw-test-state.js");
// Match the SDK's native host so its module-local workspace bindings are shared.
const workspaceSdk = tryNativeRequireModule(
  path.join(repository, "src/plugin-sdk/agent-workspace-runtime.ts"),
  {
    aliasMap: preparePluginLoaderAliases({
      modulePath: memorySource,
      devSourceRoot: repository,
      pluginSdkResolution: "src",
    }).resolveAlias,
  },
);
assert(workspaceSdk.ok, "Expected the native workspace SDK fixture");
const { registerAgentWorkspaceAccess } =
  workspaceSdk.moduleExport as typeof import("../plugin-sdk/agent-workspace-runtime.js");
const { resolveSessionTranscriptsDirForAgent } = loadHost(
  path.join(repository, "src/config/sessions/paths.ts"),
) as typeof import("../config/sessions/paths.js");
const { buildFileEntry, buildMultimodalChunkForIndexing, listMemoryFiles } = loadHost(
  path.join(repository, "packages/memory-host-sdk/src/host/internal.ts"),
) as typeof import("../../packages/memory-host-sdk/src/host/internal.js");
const { readMemoryFile } = loadHost(
  path.join(repository, "packages/memory-host-sdk/src/host/read-file.ts"),
) as typeof import("../../packages/memory-host-sdk/src/host/read-file.js");
const { upsertSessionEntry } = loadHost(
  path.join(repository, "src/plugin-sdk/session-store-runtime.ts"),
) as typeof import("../plugin-sdk/session-store-runtime.js");
const { appendSessionTranscriptMessageByIdentity, publishSessionTranscriptUpdateByIdentity } =
  loadHost(
    path.join(repository, "src/plugin-sdk/session-transcript-runtime.ts"),
  ) as typeof import("../plugin-sdk/session-transcript-runtime.js");

type RegistryHost = ReturnType<typeof createPluginRegistry>;
type SyncReason = "watch" | "interval" | "session-delta" | "session-startup-catchup";

function enableInterval(manager: object) {
  // Interval scheduling is dormant in current config defaults. Exercise the
  // existing owner without inventing a public config option.
  const scheduled = manager as {
    settings: { sync: { intervalMinutes: number } };
    ensureIntervalSync(): void;
  };
  scheduled.settings.sync.intervalMinutes = 1;
  scheduled.ensureIntervalSync();
}

function registryHost() {
  return createPluginRegistry({
    logger,
    runtime: createLazyPluginRuntime({ devSourceRoot: repository, pluginSdkResolution: "src" }),
    activateGlobalSideEffects: false,
  });
}

function loadMemory(host: RegistryHost, config: OpenClawConfig) {
  const record = createPluginRecord({
    id: "memory-core",
    origin: "bundled",
    source: memorySource,
    rootDir: path.dirname(memorySource),
    kind: "memory",
    memorySlotSelected: true,
  });
  host.registry.plugins.push(record);
  const api = host.createApi(record, { config });
  const instance = getPluginInstance(record) as PluginInstance;
  bindPluginInstanceModuleLoader({
    instance,
    origin: "bundled",
    source: memorySource,
    rootDir: path.dirname(memorySource),
    devSourceRoot: repository,
    pluginSdkResolution: "src",
  });
  const module = instance.loadModule(memorySource) as { default: OpenClawPluginDefinition };
  assert(module.default.register);
  runPluginRegisterSyncInRegistry(module.default.register, api, host.registry, record.id);
  const runtime = host.registry.memoryCapabilities[0]?.capability.runtime;
  assert(runtime);
  return { record, instance, runtime };
}

function registerMemoryWorkspaceWatch(workspace: string) {
  const subscriptions: Array<{ notify: () => void; signal: AbortSignal }> = [];
  let nextSubscription = createDeferredCore();
  const files: MemoryWorkspaceFiles = {
    assertCurrent() {},
    listFiles: listMemoryFiles,
    inspectFile: buildFileEntry,
    readFile: readMemoryFile,
    readForIndexing: async (file) => ({
      content: await fs.readFile(file, "utf8"),
      canonicalRelativePath: path.relative(workspace, file),
    }),
    buildMultimodalChunk: buildMultimodalChunkForIndexing,
    watch: async (_request, onChange, watchSignal) => {
      subscriptions.push({
        notify: AsyncLocalStorage.bind(() => onChange("change")),
        signal: watchSignal,
      });
      nextSubscription.resolve();
      nextSubscription = createDeferredCore();
      await new Promise<void>((resolve) => {
        watchSignal.addEventListener("abort", () => resolve(), { once: true });
      });
    },
  };
  const unused = async (): Promise<never> => {
    throw new Error("Unexpected document bridge operation");
  };
  const release = registerAgentWorkspaceAccess(workspace, {
    memoryFiles: files,
    bridge: { readFile: unused, writeFile: unused, stat: unused },
  });
  return { subscriptions, release, nextSubscription: () => nextSubscription.promise };
}

it("retires live watchers and starts successor indexing without a search or turn", async ({
  signal,
}) => {
  const state = await createOpenClawTestState({ label: "memory-watcher-retirement" });
  const config: OpenClawConfig = {
    agents: { entries: { main: { workspace: state.workspaceDir } } },
    memory: {
      search: {
        provider: "none",
        sources: ["memory"],
        store: { vector: { enabled: false } },
      },
    },
  };
  const { subscriptions, release, nextSubscription } = registerMemoryWorkspaceWatch(
    state.workspaceDir,
  );
  const instances: PluginInstance[] = [];
  let closeInitial: (() => Promise<void>) | undefined;
  try {
    const initial = registryHost();
    const memory = loadMemory(initial, config);
    instances.push(memory.instance);
    const opened = await memory.runtime.getMemorySearchManager({ cfg: config, agentId: "main" });
    assert(opened.manager, opened.error ?? "Expected the initial memory manager");
    const raw = getPluginOriginalValue(opened.manager, memory.instance) ?? opened.manager;
    const prototype = Object.getPrototypeOf(raw) as RegisteredMemorySearchManager;
    closeInitial = async () => {
      await prototype.close?.call(raw);
    };
    const sync = prototype.sync;
    assert(sync);
    const indexedChunks = createDeferredCore<number | undefined>();
    const observed = vi.spyOn(prototype, "sync").mockImplementation(function (
      this: RegisteredMemorySearchManager,
      params,
    ) {
      const work = sync.call(this, params);
      if (params?.reason === "watch") {
        indexedChunks.resolve(work.then(() => this.status().chunks));
      }
      return work;
    });
    expect(subscriptions).toHaveLength(1);
    await expect(memory.instance.dispose()).resolves.toEqual({ errors: [] });
    expect.soft(subscriptions[0]!.signal.aborted, "retired watch subscription").toBe(true);

    const successor = registryHost();
    const current = loadMemory(successor, config);
    instances.push(current.instance);
    const registration = successor.registry.services.find(
      ({ service }) => service.id === "memory-core-index",
    );
    assert(registration, "Memory Core must start its index through the Gateway service lifecycle");
    const service = registration.service;
    assert(service.apiVersion !== 2);
    const context = { config, stateDir: state.stateDir, logger };
    const successorWatching = nextSubscription();
    await service.start(context);
    await withinTest(successorWatching, signal);
    expect(subscriptions).toHaveLength(2);
    expect(subscriptions[1]!.signal.aborted).toBe(false);
    await fs.mkdir(path.join(state.workspaceDir, "memory"), { recursive: true });
    await fs.writeFile(
      path.join(state.workspaceDir, "memory", "after-reload.md"),
      "Violet cranes nest beside the lagoon.",
    );
    subscriptions[0]!.notify();
    expect(observed).not.toHaveBeenCalled();
    subscriptions[1]!.notify();
    expect(await withinTest(indexedChunks.promise, signal)).toBeGreaterThan(0);
    await service.stop?.(context);
    expect(subscriptions[1]!.signal.aborted).toBe(true);
    const restartedWatching = nextSubscription();
    await service.start(context);
    await withinTest(restartedWatching, signal);
    expect(subscriptions).toHaveLength(3);
    await expect(current.instance.dispose()).resolves.toEqual({ errors: [] });
    expect(subscriptions.every((subscription) => subscription.signal.aborted)).toBe(true);
  } finally {
    // Also release the original manager when the pre-fix retirement assertion fails.
    await closeInitial?.();
    for (const instance of instances.toReversed()) {
      await instance.dispose();
    }
    release();
    vi.restoreAllMocks();
    await state.cleanup();
  }
});

it.for([false, true])(
  "syncs detached background work after reload (replace Memory Core: %s)",
  async (replaceMemory, { signal }) => {
    let awaitingStage = "fixture state creation";
    let awaitingInstance: PluginInstance | undefined;
    const reportInterruptedStage = () => {
      console.error("Memory background reload interrupted", {
        replaceMemory,
        awaitingStage,
        pluginId: awaitingInstance?.pluginId,
        ordinaryCalls: awaitingInstance?.ordinaryCallCount,
        retainedWork: awaitingInstance?.retainedWorkCount,
        disposing: awaitingInstance?.disposing,
      });
    };
    signal.addEventListener("abort", reportInterruptedStage, { once: true });
    const state = await createOpenClawTestState({ label: "memory-background-reload" });
    const managers = new Set<RegisteredMemorySearchManager>();
    const instances: PluginInstance[] = [];
    const releases: Array<() => void> = [];
    const embedded: Array<{ generation: number; turn?: string; request?: AbortSignal }> = [];
    const request = new AbortController();
    const inTurn = <T>(run: () => T) =>
      openingTurn.run("opening-turn", () =>
        withPluginRuntimeGatewayRequestScope(
          { isWebchatConnect: () => false, signal: request.signal },
          run,
        ),
      );
    const config = (agentId: string, reason?: SyncReason): OpenClawConfig => ({
      plugins: { enabled: false },
      agents: { entries: { [agentId]: { workspace: path.join(state.workspaceDir, agentId) } } },
      memory: {
        search: {
          provider: providerId,
          model: "synthetic",
          fallback: "none",
          sources: reason?.startsWith("session") ? ["sessions"] : ["memory"],
          rememberAcrossConversations: true,
          cache: { enabled: false },
          store: { vector: { enabled: false } },
        },
      },
    });
    const addProvider = (host: RegistryHost, generation: number) => {
      const record = createPluginRecord({
        id: providerId,
        contracts: { embeddingProviders: [providerId] },
      });
      host.registry.plugins.push(record);
      const api = host.createApi(record, { config: config("bootstrap") });
      api.registerEmbeddingProvider({
        id: providerId,
        create: async () => ({
          provider: {
            id: providerId,
            model: "synthetic",
            embed: async () => [1, 0],
            embedBatch: async (texts) => {
              embedded.push({
                generation,
                turn: openingTurn.getStore(),
                request: getPluginRuntimeGatewayRequestScope()?.signal,
              });
              return texts.map(() => [1, 0]);
            },
          },
        }),
      });
      const instance = getPluginInstance(record) as PluginInstance;
      instances.push(instance);
      return instance;
    };
    const seedSession = async (agentId: string) => {
      const storePath = path.join(resolveSessionTranscriptsDirForAgent(agentId), "sessions.json");
      const sessionId = "background-session";
      const sessionKey = `agent:${agentId}:memory:${sessionId}`;
      await upsertSessionEntry({
        agentId,
        sessionKey,
        storePath,
        entry: { sessionId, updatedAt: Date.now() },
      });
      await appendSessionTranscriptMessageByIdentity({
        agentId,
        sessionId,
        sessionKey,
        storePath,
        message: {
          role: "user",
          timestamp: Date.now(),
          content: [{ type: "text", text: `Remember the violet ${agentId} background fact.` }],
        },
      });
      return { agentId, sessionId, sessionKey, storePath };
    };
    const errors: unknown[] = [];
    try {
      const initial = registryHost();
      const oldProvider = addProvider(initial, 1);
      const memory = inTurn(() => loadMemory(initial, config("bootstrap")));
      instances.push(memory.instance);
      awaitingInstance = memory.instance;
      awaitingStage = "initial manager acquisition";
      const boot = await inTurn(() =>
        memory.runtime.getMemorySearchManager({
          cfg: config("bootstrap"),
          agentId: "bootstrap",
          purpose: "cli",
        }),
      );
      assert(boot.manager, boot.error ?? "Expected initial memory manager");
      managers.add(boot.manager);
      const raw = getPluginOriginalValue(boot.manager, memory.instance) ?? boot.manager;
      const prototype = Object.getPrototypeOf(raw) as RegisteredMemorySearchManager;
      const sync = prototype.sync;
      assert(sync);
      const completions = new Map<string, ReturnType<typeof createDeferredCore<Promise<void>>>>();
      const syncObserver = vi.spyOn(prototype, "sync").mockImplementation(function (
        this: RegisteredMemorySearchManager,
        params,
      ) {
        const work = sync.call(this, params);
        if (params?.reason) {
          completions.get(params.reason)?.resolve(work);
        }
        return work;
      });
      const startupCompletions = new WeakMap<object, Promise<string[]>>();
      const startupOwner = prototype as RegisteredMemorySearchManager & {
        runSessionStartupCatchup(): Promise<string[]>;
      };
      // oxlint-disable-next-line typescript/unbound-method -- The observer forwards the actual manager receiver with call().
      const startup = startupOwner.runSessionStartupCatchup;
      vi.spyOn(startupOwner, "runSessionStartupCatchup").mockImplementation(function (
        this: object,
      ) {
        const work = startup.call(this);
        startupCompletions.set(this, work);
        return work;
      });
      vi.useFakeTimers({
        toFake: ["setInterval", "clearInterval"],
        shouldClearNativeTimers: true,
      });
      const oldInterval = vi.spyOn(globalThis, "setInterval");
      memory.instance.run(() => enableInterval(raw));
      const retiredInterval = oldInterval.mock.calls.at(-1)?.[0];
      assert(retiredInterval, "Initial manager must install its interval callback");
      awaitingStage = "initial manager close";
      await boot.manager.close?.();
      managers.delete(boot.manager);
      oldInterval.mockRestore();
      vi.useRealTimers();

      const successor = registryHost();
      addProvider(successor, 2);
      const prepared = memory.runtime.prepareReload?.({
        retireRuntime: replaceMemory,
        retiringEmbeddingProviders: initial.registry.embeddingProviders.map(
          ({ provider }) => provider,
        ),
      });
      awaitingStage = "prepareReload drain";
      await expect(prepared?.drain()).resolves.toEqual({ errors: [] });
      let current = memory;
      if (replaceMemory) {
        awaitingStage = "initial Memory Core disposal";
        await expect(memory.instance.dispose()).resolves.toEqual({ errors: [] });
        awaitingStage = "replacement Memory Core registration";
        current = inTurn(() => loadMemory(successor, config("bootstrap")));
        instances.push(current.instance);
      } else {
        successor.registry.plugins.push(memory.record);
        successor.registry.memoryCapabilities.push(...initial.registry.memoryCapabilities);
      }
      adoptPluginRegistryRecords(successor.registry);
      awaitingStage = "old embedding provider disposal";
      awaitingInstance = oldProvider;
      await expect(oldProvider.dispose()).resolves.toEqual({ errors: [] });
      awaitingInstance = current.instance;
      if (!replaceMemory) {
        prepared?.resume();
      }
      expect(current.instance === memory.instance).toBe(!replaceMemory);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
      // Fake timers do not carry Node's async-resource context on their own.
      const timeout = globalThis.setTimeout;
      const interval = globalThis.setInterval;
      vi.spyOn(globalThis, "setTimeout").mockImplementation((callback, delay, ...args) =>
        timeout(AsyncLocalStorage.bind(callback), delay, ...args),
      );
      vi.spyOn(globalThis, "setInterval").mockImplementation((callback, delay, ...args) =>
        interval(AsyncLocalStorage.bind(callback), delay, ...args),
      );
      for (const reason of [
        "session-startup-catchup",
        "session-delta",
        "watch",
        "interval",
      ] as const) {
        awaitingStage = `${reason}: prepare sources`;
        const agentId = reason;
        const cfg = config(agentId, reason);
        const workspace = path.join(state.workspaceDir, agentId);
        await fs.mkdir(workspace, { recursive: true });
        await fs.writeFile(
          path.join(workspace, "MEMORY.md"),
          `Remember the violet ${reason} fact.`,
        );
        let watchedWorkspace: ReturnType<typeof registerMemoryWorkspaceWatch> | undefined;
        if (reason === "watch" || reason === "interval") {
          watchedWorkspace = registerMemoryWorkspaceWatch(workspace);
          releases.push(watchedWorkspace.release);
        }
        if (reason === "session-startup-catchup") {
          await seedSession(agentId);
        }
        const completed = createDeferredCore<Promise<void>>();
        completions.set(reason, completed);
        const before = embedded.length;
        awaitingStage = `${reason}: open manager`;
        const opened = await inTurn(() => current.runtime.getMemorySearchManager({ cfg, agentId }));
        assert(opened.manager, opened.error ?? "Expected replacement memory manager");
        managers.add(opened.manager);
        const rawManager =
          getPluginOriginalValue(opened.manager, current.instance) ?? opened.manager;
        if (reason === "session-delta") {
          const startupWork = startupCompletions.get(rawManager);
          assert(startupWork, "Constructor must own startup discovery");
          awaitingStage = "session-delta: empty startup completion";
          await withinTest(startupWork, signal);
          awaitingStage = "session-delta: publish transcript update";
          await inTurn(async () => {
            const target = await seedSession(agentId);
            await publishSessionTranscriptUpdateByIdentity(target);
          });
          await vi.advanceTimersByTimeAsync(5_000);
        } else if (reason === "watch") {
          const subscription = watchedWorkspace?.subscriptions.at(-1);
          assert(subscription, "Memory manager must subscribe to its workspace host");
          inTurn(subscription.notify);
        } else if (reason === "interval") {
          inTurn(() => enableInterval(rawManager));
          await vi.advanceTimersByTimeAsync(60_000);
        }
        awaitingStage = `${reason}: sync completion`;
        await withinTest(completed.promise, signal);
        expect(embedded.slice(before), reason).not.toHaveLength(0);
        expect(
          embedded
            .slice(before)
            .every((entry) => entry.generation === 2 && !entry.turn && !entry.request),
          reason,
        ).toBe(true);
        expect(opened.manager.status().chunks, reason).toBeGreaterThan(0);
        awaitingStage = `${reason}: manager close`;
        await opened.manager.close?.();
        managers.delete(opened.manager);
      }
      if (replaceMemory) {
        awaitingStage = "retired manager interval callback";
        // A queued callback may arrive after cancellation from a newer caller.
        // Its manager must still ask the original owner for admission.
        const callsBefore = current.instance.ordinaryCallCount;
        const syncsBefore = syncObserver.mock.calls.length;
        current.instance.run(() => retiredInterval());
        expect(current.instance.ordinaryCallCount).toBe(callsBefore);
        expect(syncObserver).toHaveBeenCalledTimes(syncsBefore);
        await expect(async () =>
          memory.runtime.getMemorySearchManager({ cfg: config("retired"), agentId: "retired" }),
        ).rejects.toThrow("Plugin memory-core was reloaded or disabled");
      }
    } catch (error) {
      errors.push(error);
    } finally {
      awaitingStage = "fixture cleanup";
      const closed = await Promise.allSettled(
        [...managers].map(async (manager) => await manager.close?.()),
      );
      for (const release of releases.toReversed()) {
        release();
      }
      vi.restoreAllMocks();
      vi.useRealTimers();
      const disposed = await Promise.allSettled(
        instances.toReversed().map(async (instance) => await instance.dispose()),
      );
      const cleaned = await Promise.allSettled([state.cleanup()]);
      signal.removeEventListener("abort", reportInterruptedStage);
      errors.push(
        ...[...closed, ...disposed, ...cleaned].flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        ),
        ...disposed.flatMap((result) => (result.status === "fulfilled" ? result.value.errors : [])),
      );
    }
    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, "Memory background reload and cleanup failed");
    }
  },
);
