import "../test-utils/prepare-compiled-subprocesses.js";
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import {
  buildFileEntry,
  buildMultimodalChunkForIndexing,
  listMemoryFiles,
} from "../../packages/memory-host-sdk/src/host/internal.js";
import { readMemoryFile } from "../../packages/memory-host-sdk/src/host/read-file.js";
import type { MemoryWorkspaceFiles } from "../../packages/memory-host-sdk/src/host/workspace-files.js";
import { withinTest } from "../../test/helpers/promise.js";
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
      const resolveGateway = () => gateway;
      bindGatewayContextResolver(runtime, resolveGateway);
    },
    dispose: () => getPluginInstance(record)!.dispose(),
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

it.each([
  { managed: false, phase: "inspection" as const },
  { managed: true, phase: "inspection" as const },
  { managed: true, phase: "preparation" as const },
])(
  "scrubs historical dreaming artifacts after pending $phase (managed: $managed)",
  async ({ managed, phase }) => {
    await withOpenClawTestState(
      { label: "dreaming-admission", layout: "state-only" },
      async (state) => {
        const config: OpenClawConfig = {
          cron: { enabled: false },
          agents: { entries: { main: { workspace: state.workspaceDir } } },
        };
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
        const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
        const hooks = vi.fn<OpenClawPluginApi["on"]>();
        const services: Parameters<OpenClawPluginApi["registerService"]>[0][] = [];
        const owner = managed ? createManagedMemoryCore(config, logger) : undefined;
        const api =
          owner?.api ??
          createTestPluginApi({
            config,
            logger,
            on: hooks,
            registerService: (service) => services.push(service),
          });
        if (!owner) {
          Object.assign(api.runtime, { config: { current: () => config } });
          memoryCore.register?.(api);
        }
        const service = (owner?.registry.services.map((entry) => entry.service) ?? services).find(
          (entry) => entry.id === "memory-core-dreaming",
        );
        const hook = owner
          ? owner.registry.typedHooks.find((entry) => entry.hookName === "gateway_start")?.handler
          : hooks.mock.calls.find(([name]) => name === "gateway_start")?.[1];
        if (!service || service.apiVersion === 2 || !hook) {
          throw new Error("Memory Core did not register its startup lifecycle");
        }
        const scheduler = createTestPluginServiceScheduler();
        const context = {
          config,
          stateDir: state.stateDir,
          logger,
          scheduler,
          getCron: () => ({
            isEnabled: async () => false,
            list: async () => [],
            add: async () => {},
            update: async () => {},
            remove: async () => ({ removed: false }),
            removeStaleJobFamily: async () => 0,
          }),
        };
        try {
          await withPendingPreparation(
            state,
            async (admission, activate) => {
              const joining = createDeferredCore();
              const wait = admission.waitForAgentPreparation.bind(admission);
              vi.spyOn(admission, "waitForAgentPreparation").mockImplementation((...args) => {
                if (managed) {
                  expect(getAgentDatabaseStartupAdmission()).toBeUndefined();
                }
                const preparation = wait(...args);
                joining.resolve();
                return preparation;
              });
              owner?.bindGateway();
              await service.start(context);
              const startup = (
                hook as (event: { port: number }, ctx: { config: OpenClawConfig }) => Promise<void>
              )({ port: 0 }, { config });
              // On the regression, the hook settles with a warning instead of joining preparation.
              await Promise.race([joining.promise, startup]);
              const prepared = wait("main", { env: state.env });
              expect(prepared).toBeDefined();
              activate();
              await prepared;
              await startup;
              expect.soft(logger.warn.mock.calls).toEqual([]);
              expect.soft(getSessionEntry({ agentId: "main", sessionKey })).toBeUndefined();
              expect
                .soft(await readSessionTranscriptEvents({ agentId: "main", sessionKey, sessionId }))
                .toEqual([]);
              expect(logger.info).toHaveBeenCalledWith(
                "memory-core: dreaming cleanup scrubbed 1 stale session entry and archived 0 orphan transcripts.",
              );
            },
            phase,
          );
        } finally {
          scheduler.beginClose();
          await service.stop?.(context);
          await scheduler.stop();
          await owner?.dispose();
        }
      },
    );
  },
);

it("captures a store created during preparation only after admission completes", async () => {
  await withOpenClawTestState(
    { label: "cleanup-store-creation", layout: "state-only" },
    async (state) => {
      await withPendingPreparation(state, async (_admission, activate) => {
        const storePath = state.statePath("companion.sqlite");
        const cleanup = cleanupSessionLifecycleArtifacts({ ...cleanupParams, storePath });
        const outcome = expect(cleanup).resolves.toEqual({
          removedEntries: 0,
          archivedTranscriptArtifacts: 0,
        });
        activate(() => {
          openOpenClawAgentDatabase({ agentId: "main", path: storePath });
        });
        await outcome;
        expect(fs.existsSync(storePath)).toBe(true);
      });
    },
  );
});

it("does not wait for unrelated pending agents when the selected agent is prepared", async () => {
  await withOpenClawTestState(
    { label: "cleanup-prepared", layout: "state-only" },
    async (state) => {
      openOpenClawAgentDatabase({ agentId: "healthy" });
      await withPendingPreparation(state, async (admission) => {
        expect(admission.waitForAgentPreparation("healthy", { env: state.env })).toBeUndefined();
        await expect(
          cleanupSessionLifecycleArtifacts({ ...cleanupParams, agentId: "healthy" }),
        ).resolves.toEqual({
          removedEntries: 0,
          archivedTranscriptArtifacts: 0,
        });
        expect(admission.hasPendingAgents).toBe(true);
      });
    },
  );
});

it("surfaces failed startup preparation through normal cleanup admission", async () => {
  await withOpenClawTestState(
    { label: "cleanup-failed-preparation", layout: "state-only" },
    async (state) => {
      await withPendingPreparation(state, async (_admission, activate) => {
        const cleanup = cleanupSessionLifecycleArtifacts(cleanupParams);
        const outcome = expect(cleanup).rejects.toThrow("synthetic preparation failure");
        activate(() => {
          throw new Error("synthetic preparation failure");
        });
        await outcome;
      });
    },
  );
});

it("cancels pending cleanup when the startup admission owner stops", async () => {
  await withOpenClawTestState(
    { label: "cleanup-startup-stop", layout: "state-only" },
    async (state) => {
      await withPendingPreparation(state, async (admission, activate) => {
        const outcome = expect(
          cleanupSessionLifecycleArtifacts(cleanupParams),
        ).rejects.toMatchObject({
          name: "AbortError",
          cause: { message: "Gateway stopped during agent database inspection" },
        });
        const stopping = admission.stop();
        activate();
        await outcome;
        await stopping;
      });
    },
  );
});

it("keeps the identity guard for creation outside startup preparation", async () => {
  await withOpenClawTestState(
    { label: "cleanup-owner-change", layout: "state-only" },
    async (state) => {
      const cleanup = cleanupSessionLifecycleArtifacts(cleanupParams);
      openOpenClawAgentDatabase({ agentId: "main" });
      await expect(cleanup).rejects.toThrow("SQLite lifecycle cleanup database owner changed");
      await closeOpenClawAgentDatabasesAsync(state.stateDir);
      await expect(cleanupSessionLifecycleArtifacts(cleanupParams)).resolves.toEqual({
        removedEntries: 0,
        archivedTranscriptArtifacts: 0,
      });
    },
  );
});

it.for([
  { phase: "inspection" as const, outcome: "watch" },
  { phase: "preparation" as const, outcome: "watch" },
  { phase: "preparation" as const, outcome: "failed" },
  { phase: "preparation" as const, outcome: "dispose" },
])("activates indexes after pending $phase ($outcome)", async ({ phase, outcome }, { signal }) => {
  await withOpenClawTestState(
    { label: "memory-index-admission", layout: "state-only" },
    async (state) => {
      const config: OpenClawConfig = {
        cron: { enabled: false },
        agents: { entries: { main: { workspace: state.workspaceDir } } },
        memory: {
          search: {
            provider: "none",
            sources: ["memory"],
            store: { vector: { enabled: false } },
          },
        },
      };
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
      const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const owner = createManagedMemoryCore(config, logger);
      const instance = getPluginInstance(owner.registry.plugins[0]!)!;
      const registeredRuntime = owner.registry.memoryCapabilities[0]?.capability.runtime;
      const service = owner.registry.services.find(
        (entry) => entry.service.id === "memory-core-index",
      )?.service;
      if (!registeredRuntime || !service || service.apiVersion === 2) {
        throw new Error("Memory Core did not register its indexing lifecycle");
      }
      const runtime = (getPluginOriginalValue(registeredRuntime, instance) ??
        registeredRuntime) as typeof registeredRuntime;
      const getManager = runtime.getMemorySearchManager.bind(runtime);
      const acquired = createDeferredCore<Awaited<ReturnType<typeof getManager>>>();
      const acquisition = vi
        .spyOn(runtime, "getMemorySearchManager")
        .mockImplementation((params) => {
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
            const wait = admission.waitForAgentPreparation.bind(admission);
            let joinedPreparation = false;
            vi.spyOn(admission, "waitForAgentPreparation").mockImplementation((...args) => {
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
                expect(subscriptions.every((subscription) => subscription.signal.aborted)).toBe(
                  true,
                );
                return;
              }
              if (outcome === "failed") {
                await service.stop?.(context);
                expect(result.manager).toBeNull();
                expect(logger.warn).toHaveBeenCalledTimes(1);
                expect(logger.warn).toHaveBeenCalledWith(
                  expect.stringContaining("memory-core: index startup failed for main:"),
                );
                expect(logger.warn).toHaveBeenCalledWith(
                  expect.stringContaining("synthetic index preparation failure"),
                );
                expect(subscriptions).toHaveLength(0);
                return;
              }
              const manager = result.manager;
              if (!manager?.sync) {
                throw new Error(result.error ?? "Startup did not acquire a memory manager");
              }
              expect(logger.warn).not.toHaveBeenCalled();
              expect(subscriptions).toHaveLength(1);
              const indexed = createDeferredCore();
              const sync = manager.sync.bind(manager);
              vi.spyOn(manager, "sync").mockImplementation((params) => {
                const work = sync(params);
                if (params?.reason === "watch") {
                  indexed.resolve(work);
                }
                return work;
              });
              await fs.promises.mkdir(state.workspaceDir, { recursive: true });
              await fs.promises.writeFile(
                path.join(state.workspaceDir, "MEMORY.md"),
                "Violet cranes nest beside the lagoon.",
              );
              subscriptions[0]!.notify();
              await withinTest(indexed.promise, signal);
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
    },
  );
});
