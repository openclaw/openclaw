import fs from "node:fs";
import { expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
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
import { createDeferredCore } from "../shared/deferred.js";
import { loadBundledPluginFacade } from "../test-utils/bundled-plugin-public-surface.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { recordAgentDatabaseAdmissions } from "./agent-database-admission.js";
import { withAgentDatabaseStartupAdmission } from "./agent-database-startup.js";
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

async function withPendingPreparation(
  state: OpenClawTestState,
  run: (admission: StartupAdmission, activate: (prepare?: () => void) => void) => Promise<void>,
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
    try {
      await run(admission, (prepare) => {
        admission.activate({
          isCurrent: () => true,
          preparationReady: Promise.resolve(),
          openAgent: async () => {
            openOpenClawAgentDatabase({ agentId: "main" });
            prepare?.();
          },
          migrateAgent: async () => {},
          publishAgent: async () => {},
        });
        inspection.resolve({ incompatible: [], indeterminate: [] });
      });
    } finally {
      inspection.resolve({ incompatible: [], indeterminate: [] });
      await owner.stop();
      vi.restoreAllMocks();
    }
  });
}

it("scrubs historical dreaming artifacts without warning after pending startup admission", async () => {
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
        event: { type: "metadata", timestamp: updatedAt, runId: "dreaming-narrative-interrupted" },
      });
      const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const hooks = vi.fn<OpenClawPluginApi["on"]>();
      const services: Parameters<OpenClawPluginApi["registerService"]>[0][] = [];
      const api = createTestPluginApi({
        config,
        logger,
        on: hooks,
        registerService: (service) => services.push(service),
      });
      Object.assign(api.runtime, { config: { current: () => config } });
      memoryCore.register?.(api);
      const service = services.find((entry) => entry.id === "memory-core-dreaming");
      const hook = hooks.mock.calls.find(([name]) => name === "gateway_start")?.[1];
      if (!service || !hook) {
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
        await withPendingPreparation(state, async (admission, activate) => {
          const joining = createDeferredCore();
          const wait = admission.waitForAgentPreparation.bind(admission);
          vi.spyOn(admission, "waitForAgentPreparation").mockImplementation((...args) => {
            const preparation = wait(...args);
            joining.resolve();
            return preparation;
          });
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
        });
      } finally {
        scheduler.beginClose();
        await service.stop?.(context);
        await scheduler.stop();
      }
    },
  );
});

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
