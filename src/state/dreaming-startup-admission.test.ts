import "../test-utils/prepare-compiled-subprocesses.js";
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";
import {
  buildFileEntry,
  buildMultimodalChunkForIndexing,
  listMemoryFiles,
} from "../../packages/memory-host-sdk/src/host/internal.js";
import { readMemoryFile } from "../../packages/memory-host-sdk/src/host/read-file.js";
import type { MemoryWorkspaceFiles } from "../../packages/memory-host-sdk/src/host/workspace-files.js";
import { withinTest } from "../../test/helpers/promise.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import * as artifactCleanup from "../config/sessions/session-accessor.sqlite-artifact-cleanup.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createGatewayRequestContext } from "../gateway/server-request-context.js";
import { makeContextParams } from "../gateway/server-request-context.test-support.js";
import { registerAgentWorkspaceAccess } from "../plugin-sdk/agent-workspace-runtime.js";
import type { OpenClawPluginApi, OpenClawPluginDefinition } from "../plugin-sdk/plugin-entry.js";
import {
  createTestPluginApi,
  createTestPluginServiceScheduler,
} from "../plugin-sdk/plugin-test-api.js";
import {
  cleanupSessionLifecycleArtifacts,
  getSessionEntry,
  upsertSessionEntry,
} from "../plugin-sdk/session-store-runtime.js";
import { readSessionTranscriptEvents } from "../plugin-sdk/session-transcript-runtime.js";
import { appendSqliteSessionTranscriptEventForTest } from "../plugin-sdk/sqlite-runtime-testing.js";
import { getPluginInstance, getPluginOriginalValue } from "../plugins/plugin-instance-scope.js";
import { createPluginRegistry } from "../plugins/registry.js";
import { bindGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { createDeferredCore } from "../shared/deferred.js";
import { loadBundledPluginFacade } from "../test-utils/bundled-plugin-public-surface.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { recordAgentDatabaseAdmissions } from "./agent-database-admission.js";
import {
  getAgentDatabaseStartupAdmission,
  withAgentDatabaseStartupAdmission,
} from "./agent-database-startup.js";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
} from "./openclaw-agent-db.js";

type StartupAdmission = Parameters<Parameters<typeof withAgentDatabaseStartupAdmission>[0]>[0];

const { default: memoryCore } = await loadBundledPluginFacade<{
  default: OpenClawPluginDefinition;
}>({ pluginId: "memory-core", artifactBasename: "index.js" });

const cleanupParams = {
  agentId: "main",
  pluginOwnerId: "memory-core",
  sessionKeySegmentPrefix: "dreaming-narrative-",
  transcriptContentMarker: '"runId":"dreaming-narrative-',
  orphanTranscriptMinAgeMs: 300_000,
  archiveRemovedEntryTranscripts: false,
};
const emptyCleanup = { removedEntries: 0, archivedTranscriptArtifacts: 0 };
const makeLogger = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

function memoryConfig(workspace: string, memory?: OpenClawConfig["memory"]): OpenClawConfig {
  return { cron: { enabled: false }, agents: { entries: { main: { workspace } } }, memory };
}

function publishConfig(config: OpenClawConfig) {
  setRuntimeConfigSnapshot(config, config);
  onTestFinished(clearRuntimeConfigSnapshot);
}

const disabledCron = {
  isEnabled: async () => false,
  list: async () => [],
  add: async () => {},
  update: async () => {},
  remove: async () => ({ removed: false }),
  removeStaleJobFamily: async () => 0,
};

function createManagedMemoryCore(config: OpenClawConfig, logger: OpenClawPluginApi["logger"]) {
  const runtime = createTestPluginApi().runtime;
  Object.assign(runtime, { config: { current: () => config } });
  const owner = createPluginRegistry({ logger, runtime, activateGlobalSideEffects: false });
  const record = createPluginRecord({
    id: "memory-core",
    origin: "bundled",
    kind: "memory",
    memorySlotSelected: true,
  });
  owner.registry.plugins.push(record);
  const api = owner.createApi(record, { config });
  memoryCore.register?.(api);
  return {
    ...owner,
    api,
    bindGateway() {
      const gateway = createGatewayRequestContext(makeContextParams());
      bindGatewayContextResolver(runtime, () => gateway);
    },
    dispose: () => getPluginInstance(record)!.dispose(),
  };
}

function withState(label: string, run: (state: OpenClawTestState) => Promise<void>) {
  return withOpenClawTestState({ label, layout: "state-only" }, run);
}

function dreamingFixture(state: OpenClawTestState, config: OpenClawConfig) {
  const logger = makeLogger();
  const owner = createManagedMemoryCore(config, logger);
  const service = owner.registry.services.find(
    (entry) => entry.service.id === "memory-core-dreaming",
  )?.service;
  const hook = owner.registry.typedHooks.find(
    (entry) => entry.hookName === "gateway_start",
  )?.handler;
  assert(service && service.apiVersion !== 2 && hook, "Missing Memory Core startup lifecycle");
  const scheduler = createTestPluginServiceScheduler();
  const context = {
    config,
    stateDir: state.stateDir,
    logger,
    scheduler,
    getCron: () => disabledCron,
  };
  return {
    logger,
    async start() {
      owner.bindGateway();
      await service.start(context);
      return (hook as (event: { port: number }, ctx: { config: OpenClawConfig }) => Promise<void>)(
        { port: 0 },
        { config },
      );
    },
    async stop() {
      scheduler.beginClose();
      await service.stop?.(context);
      await scheduler.stop();
      await owner.dispose();
    },
  };
}

async function withPendingPreparation(
  state: OpenClawTestState,
  run: (admission: StartupAdmission, activate: (prepare?: () => void) => void) => Promise<void>,
  phase: "inspection" | "preparation" = "inspection",
) {
  const pathname = openOpenClawAgentDatabase({ agentId: "main" }).path;
  await closeOpenClawAgentDatabasesAsync(state.stateDir);
  await withAgentDatabaseStartupAdmission(async (admission) => {
    const inspection = createDeferredCore<{ incompatible: []; indeterminate: [] }>();
    recordAgentDatabaseAdmissions(
      admission.defer({
        env: state.env,
        inspections: [{ target: { agentId: "main", path: pathname }, result: inspection.promise }],
        reason: "Inspection and writable admission continue after the Gateway listener binds.",
      }),
      { env: state.env, source: "startup" },
    );
    const owner = admission.adopt();
    const preparationReady = createDeferredCore();
    let prepare: (() => void) | undefined;
    admission.activate({
      isCurrent: () => true,
      preparationReady: preparationReady.promise,
      openAgent: async () => {
        openOpenClawAgentDatabase({ agentId: "main" });
        prepare?.();
      },
      migrateAgent: async () => {},
      publishAgent: async () => {},
    });
    if (phase === "preparation") {
      inspection.resolve({ incompatible: [], indeterminate: [] });
    }
    try {
      await run(admission, (onPrepare) => {
        prepare = onPrepare;
        inspection.resolve({ incompatible: [], indeterminate: [] });
        preparationReady.resolve();
      });
    } finally {
      inspection.resolve({ incompatible: [], indeterminate: [] });
      await owner.stop();
      vi.restoreAllMocks();
    }
  });
}

it.for(["inspection", "preparation"] as const)(
  "scrubs historical dreaming artifacts after pending %s",
  async (phase, { signal }) => {
    await withState("dreaming-admission", async (state) => {
      const config = memoryConfig(state.workspaceDir);
      publishConfig(config);
      const sessionKey = "agent:main:dreaming-narrative-light-interrupted";
      const sessionId = "historical-narrative";
      const updatedAt = Date.now() - 600_000;
      await upsertSessionEntry({
        agentId: "main",
        sessionKey,
        entry: { sessionId, updatedAt, pluginOwnerId: "memory-core" },
      });
      await appendSqliteSessionTranscriptEventForTest({
        agentId: "main",
        sessionKey,
        sessionId,
        event: {
          type: "metadata",
          timestamp: updatedAt,
          runId: "dreaming-narrative-interrupted",
        },
      });
      const fixture = dreamingFixture(state, config);
      const { logger } = fixture;
      const cleaned = createDeferredCore();
      const cleanup = artifactCleanup.cleanupSessionLifecycleArtifactsCore;
      vi.spyOn(artifactCleanup, "cleanupSessionLifecycleArtifactsCore").mockImplementation(
        async (params) => {
          const result = await cleanup(params);
          cleaned.resolve();
          return result;
        },
      );
      try {
        await withPendingPreparation(
          state,
          async (admission, activate) => {
            const joining = createDeferredCore();
            const observer = admission.observation;
            const wait = observer.waitForAgentPreparation.bind(observer);
            vi.spyOn(observer, "waitForAgentPreparation").mockImplementation((...args) => {
              expect(getAgentDatabaseStartupAdmission()).toBeUndefined();
              const preparation = wait(...args);
              joining.resolve();
              return preparation;
            });
            const startup = fixture.start();
            // Startup returns while background cleanup waits for database preparation.
            await withinTest(startup, signal);
            await withinTest(joining.promise, signal);
            const prepared = wait("main", { env: state.env });
            expect(prepared).toBeDefined();
            activate();
            await prepared;
            await withinTest(cleaned.promise, signal);
            expect.soft(logger.warn.mock.calls).toEqual([]);
            expect.soft(getSessionEntry({ agentId: "main", sessionKey })).toBeUndefined();
            expect
              .soft(await readSessionTranscriptEvents({ agentId: "main", sessionKey, sessionId }))
              .toEqual([]);
          },
          phase,
        );
      } finally {
        await fixture.stop();
      }
    });
  },
);

it("captures a store created during preparation only after admission completes", async () => {
  await withState("cleanup-store-creation", async (state) => {
    await withPendingPreparation(state, async (_admission, activate) => {
      const storePath = state.statePath("companion.sqlite");
      const cleanup = cleanupSessionLifecycleArtifacts({ ...cleanupParams, storePath });
      const outcome = expect(cleanup).resolves.toEqual(emptyCleanup);
      activate(() => {
        openOpenClawAgentDatabase({ agentId: "main", path: storePath });
      });
      await outcome;
      expect(fs.existsSync(storePath)).toBe(true);
    });
  });
});

it("does not wait for unrelated pending agents when the selected agent is prepared", async () => {
  await withState("cleanup-prepared", async (state) => {
    openOpenClawAgentDatabase({ agentId: "healthy" });
    await withPendingPreparation(state, async (admission) => {
      expect(admission.waitForAgentPreparation("healthy", { env: state.env })).toBeUndefined();
      await expect(
        cleanupSessionLifecycleArtifacts({ ...cleanupParams, agentId: "healthy" }),
      ).resolves.toEqual(emptyCleanup);
      expect(admission.hasPendingAgents).toBe(true);
    });
  });
});

it.each(["failed", "stopped"] as const)("rejects cleanup when startup is %s", async (outcome) => {
  await withState("cleanup-startup-rejection", async (state) => {
    await withPendingPreparation(state, async (admission, activate) => {
      const cleanup = cleanupSessionLifecycleArtifacts(cleanupParams);
      const rejected =
        outcome === "failed"
          ? expect(cleanup).rejects.toThrow("synthetic preparation failure")
          : expect(cleanup).rejects.toMatchObject({
              name: "AbortError",
              cause: { message: "Gateway stopped during agent database inspection" },
            });
      const stopping = outcome === "stopped" ? admission.stop() : undefined;
      activate(
        outcome === "failed"
          ? () => {
              throw new Error("synthetic preparation failure");
            }
          : undefined,
      );
      await rejected;
      await stopping;
    });
  });
});

it("does not warn when fresh agent stores are created during dreaming startup cleanup", async ({
  signal,
}) => {
  await withState("dreaming-fresh-startup", async (state) => {
    const agentIds = ["main", "researcher"];
    const config: OpenClawConfig = {
      cron: { enabled: false },
      agents: {
        entries: Object.fromEntries(
          agentIds.map((id) => [id, { workspace: path.join(state.stateDir, `workspace-${id}`) }]),
        ),
      },
    };
    const fixture = dreamingFixture(state, config);
    const { logger } = fixture;
    const createStore = AsyncLocalStorage.bind((agentId: string) => {
      openOpenClawAgentDatabase({ agentId });
    });
    const cleanup = artifactCleanup.cleanupSessionLifecycleArtifactsCore;
    const startedAgents: string[] = [];
    const cleaned = createDeferredCore();
    vi.spyOn(artifactCleanup, "cleanupSessionLifecycleArtifactsCore").mockImplementation(
      (params) => {
        if ("kind" in params || !params.agentId) {
          throw new Error("Expected agent-scoped persistent startup cleanup");
        }
        expect(fs.existsSync(state.agentDir(params.agentId))).toBe(false);
        const pending = cleanup(params);
        // First creation races after the real cleanup captures the absent source.
        createStore(params.agentId);
        startedAgents.push(params.agentId);
        if (startedAgents.length === agentIds.length) {
          cleaned.resolve(pending.then(() => {}));
        }
        return pending;
      },
    );
    try {
      await fixture.start();
      await withinTest(cleaned.promise, signal);
      expect(startedAgents).toEqual(agentIds);
    } finally {
      await fixture.stop();
      vi.restoreAllMocks();
    }
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });
});

it("keeps the identity guard when an existing database is replaced", async () => {
  await withState("cleanup-owner-change", async (state) => {
    const databasePath = openOpenClawAgentDatabase({ agentId: "main" }).path;
    await closeOpenClawAgentDatabasesAsync(state.stateDir);
    const cleanup = cleanupSessionLifecycleArtifacts(cleanupParams);
    fs.renameSync(databasePath, `${databasePath}.previous`);
    openOpenClawAgentDatabase({ agentId: "main" });
    await expect(cleanup).rejects.toThrow("SQLite lifecycle cleanup database owner changed");
    await closeOpenClawAgentDatabasesAsync(state.stateDir);
    await expect(cleanupSessionLifecycleArtifacts(cleanupParams)).resolves.toEqual(emptyCleanup);
  });
});

it.for([
  { phase: "inspection" as const, outcome: "watch" },
  { phase: "preparation" as const, outcome: "watch" },
  { phase: "preparation" as const, outcome: "failed" },
  { phase: "preparation" as const, outcome: "dispose" },
])("activates indexes after pending $phase ($outcome)", async ({ phase, outcome }, { signal }) => {
  await withState("memory-index-admission", async (state) => {
    const config = memoryConfig(state.workspaceDir, {
      search: { provider: "none", sources: ["memory"], store: { vector: { enabled: false } } },
    });
    publishConfig(config);
    const subscriptions: Array<{ notify: () => void; signal: AbortSignal }> = [];
    const memoryFiles: MemoryWorkspaceFiles = {
      assertCurrent() {},
      listFiles: listMemoryFiles,
      inspectFile: buildFileEntry,
      readFile: readMemoryFile,
      readForIndexing: async (file) => ({
        content: await fs.promises.readFile(file, "utf8"),
        canonicalRelativePath: path.relative(state.workspaceDir, file),
      }),
      buildMultimodalChunk: buildMultimodalChunkForIndexing,
      watch: async (_request, onChange, watchSignal) => {
        subscriptions.push({
          notify: AsyncLocalStorage.bind(() => onChange("change")),
          signal: watchSignal,
        });
        await new Promise<void>((resolve) => {
          watchSignal.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    };
    const unused = async (): Promise<never> => {
      throw new Error("Unexpected document bridge operation");
    };
    const releaseWorkspace = registerAgentWorkspaceAccess(state.workspaceDir, {
      memoryFiles,
      bridge: { readFile: unused, writeFile: unused, stat: unused },
    });
    const logger = makeLogger();
    const owner = createManagedMemoryCore(config, logger);
    const instance = getPluginInstance(owner.registry.plugins[0]!)!;
    const registeredRuntime = owner.registry.memoryCapabilities[0]?.capability.runtime;
    const service = owner.registry.services.find(
      (entry) => entry.service.id === "memory-core-index",
    )?.service;
    assert(registeredRuntime && service && service.apiVersion !== 2, "Missing indexing lifecycle");
    const runtime = (getPluginOriginalValue(registeredRuntime, instance) ??
      registeredRuntime) as typeof registeredRuntime;
    // Service restarts reopen indexes only after a manager has run in this process.
    const earlier = await runtime.getMemorySearchManager({ cfg: config, agentId: "main" });
    assert(earlier.manager, earlier.error ?? "Expected an earlier memory manager");
    await runtime.closeAllMemorySearchManagers?.();
    subscriptions.length = 0;
    const getManager = runtime.getMemorySearchManager.bind(runtime);
    const acquired = createDeferredCore<Awaited<ReturnType<typeof getManager>>>();
    const acquisition = vi.spyOn(runtime, "getMemorySearchManager").mockImplementation((params) => {
      const result = getManager(params);
      acquired.resolve(result);
      return result;
    });
    const context = { config, stateDir: state.stateDir, logger };
    try {
      await withPendingPreparation(
        state,
        async (admission, activate) => {
          const joined = createDeferredCore();
          const observer = admission.observation;
          const wait = observer.waitForAgentPreparation.bind(observer);
          let joinedPreparation = false;
          vi.spyOn(observer, "waitForAgentPreparation").mockImplementation((...args) => {
            const preparation = wait(...args);
            joinedPreparation ||= preparation !== undefined;
            joined.resolve();
            return preparation;
          });
          owner.bindGateway();
          try {
            // Gateway releases preparationReady only after plugin services return.
            await withinTest(Promise.resolve(service.start(context)), signal);
            await withinTest(Promise.race([joined.promise, acquired.promise]), signal);
            expect(joinedPreparation).toBe(true);
            expect(subscriptions).toHaveLength(0);
            const disposing = outcome === "dispose" ? owner.dispose() : undefined;
            activate(
              outcome === "failed"
                ? () => {
                    throw new Error("synthetic index preparation failure");
                  }
                : undefined,
            );
            const result = await withinTest(acquired.promise, signal);
            if (outcome === "dispose") {
              await expect(withinTest(disposing!, signal)).resolves.toEqual({ errors: [] });
              expect(subscriptions.every((subscription) => subscription.signal.aborted)).toBe(true);
              return;
            }
            if (outcome === "failed") {
              await service.stop?.(context);
              expect(result.manager).toBeNull();
              expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
                expect.stringMatching(
                  /memory-core: index startup failed for main:.*synthetic index preparation failure/s,
                ),
              );
              expect(subscriptions).toHaveLength(0);
              return;
            }
            const manager = result.manager;
            assert(manager?.sync, result.error ?? "Startup did not acquire a memory manager");
            expect(logger.warn).not.toHaveBeenCalled();
            expect(subscriptions).toHaveLength(1);
            await fs.promises.mkdir(state.workspaceDir, { recursive: true });
            await fs.promises.writeFile(
              path.join(state.workspaceDir, "MEMORY.md"),
              "Violet cranes nest beside the lagoon.",
            );
            subscriptions[0]!.notify();
            await instance.waitForRetainedWork(signal, {
              includeConsumers: false,
              includeCalls: true,
            });
            expect(manager.status().chunks).toBeGreaterThan(0);
            expect(acquisition).toHaveBeenCalledTimes(1);
            await service.stop?.(context);
            expect(subscriptions[0]!.signal.aborted).toBe(true);
          } finally {
            activate();
            if (outcome !== "dispose") {
              await service.stop?.(context);
            }
          }
        },
        phase,
      );
    } finally {
      await owner.dispose();
      releaseWorkspace();
      vi.restoreAllMocks();
    }
  });
});
