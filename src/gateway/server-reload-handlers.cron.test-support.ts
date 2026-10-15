import { expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadCronJobsStore, resolveCronJobsStorePathFromConfigAsync } from "../cron/store.js";
import {
  activateSecretsRuntimeSnapshot,
  getActiveSecretsRuntimeSnapshot,
  getActiveSecretsRuntimeSnapshotRevision,
} from "../secrets/runtime.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { buildGatewayReloadPlan } from "./config-reload-plan.js";
import { createRecoveryRestartMock } from "./config-reload.test-support.js";
import type { GatewayCronState } from "./server-cron.js";
import type { GatewayReloadHandlerParams } from "./server-reload-contracts.js";
import {
  createDefaultGatewayReloadState,
  createMonitorPublicationFailure,
  createTestCronState,
} from "./server-reload-handlers.config.test-support.js";
import type { createGatewayReloadHandlers as createGatewayReloadHandlersImpl } from "./server-reload-hot.js";
import { createManagedReloadSecretHandlers } from "./server-reload-managed-secrets.js";
import { SharedGatewaySessionGenerationState } from "./server-shared-auth-generation.js";
import {
  createMockRuntimeSecretsActivator,
  makePreparedSecretsSnapshot,
} from "./server-startup-config.test-support.js";

export function registerGatewayCronReloadTests({
  createGatewayReloadHandlers,
  autoCleanupTempDirs,
}: {
  createGatewayReloadHandlers: (
    params: Partial<GatewayReloadHandlerParams>,
  ) => ReturnType<typeof createGatewayReloadHandlersImpl>;
  autoCleanupTempDirs: { make(prefix: string): string };
}) {
  it.each(["rejected", "noop"] as const)(
    "keeps partial monitor writes aligned with accepted config through a %s successor",
    async (successor) => {
      const clock = createGatewaySchedulerClock(Date.now());
      const scheduler = createTestGatewayScheduler(clock.clock);
      const fixtureDir = autoCleanupTempDirs.make("openclaw-monitor-publication-");
      const initialConfig: OpenClawConfig = {
        agents: {
          entries: {
            first: { heartbeat: { every: "1h" } },
            second: { heartbeat: { every: "1h" } },
          },
        },
      };
      const nextConfig = {
        ...initialConfig,
        agents: {
          entries: {
            first: { heartbeat: { every: "2h" } },
            second: { heartbeat: { every: "2h" } },
          },
        },
      } satisfies OpenClawConfig;
      activateSecretsRuntimeSnapshot(makePreparedSecretsSnapshot(initialConfig));
      const { buildGatewayCronService } =
        await vi.importActual<typeof import("./server-cron.js")>("./server-cron.js");
      const cronState = buildGatewayCronService({
        storePath: await resolveCronJobsStorePathFromConfigAsync(initialConfig, {
          ...process.env,
          OPENCLAW_STATE_DIR: fixtureDir,
        }),
        scheduler,
        cfg: initialConfig,
        deps: {} as never,
        env: { ...process.env, OPENCLAW_STATE_DIR: fixtureDir, OPENCLAW_SKIP_CRON: "0" },
        broadcast: vi.fn(),
      });
      cronState.cron.pauseScheduling();
      const publicationFailure = createMonitorPublicationFailure();
      let state = createDefaultGatewayReloadState({ cronState });
      const requestRecoveryRestart = vi.fn(() => ({ status: "emitted" as const }));
      const handlers = createGatewayReloadHandlers({
        getState: () => state,
        setState: (nextState) => {
          state = nextState;
        },
        requestRecoveryRestart,
      });
      const markRuntimeCommitted = vi.fn();
      const ownership: Parameters<typeof managed.onHotReload>[2] = {
        isCurrent: () => true,
        checkpoint: async () => {},
        withRestartPreparation: async (run) => await run(ownership),
        markRuntimeCommitted,
        publishRuntimeEnv: vi.fn(),
        commitRuntimeEnv: vi.fn(),
        rollbackRuntimeEnv: vi.fn(),
        reapplyRuntimeOverlays: (config: OpenClawConfig) => config,
      };
      const managed = createManagedReloadSecretHandlers({
        params: {
          activateRuntimeSecrets: createMockRuntimeSecretsActivator(),
          clients: [],
          sharedGatewaySessionGenerationState: new SharedGatewaySessionGenerationState({
            current: undefined,
            required: null,
          }),
          resolveSharedGatewaySessionGenerationForConfig: () => undefined,
          commitRuntimePolicy: vi.fn(),
          reconcileRuntimePolicy: vi.fn(),
        },
        prepareRuntimeCandidate: (config) => config,
        tryPrepareRuntimeSecrets: async (config) => ({
          snapshot: makePreparedSecretsSnapshot(config),
          expectedRevision: getActiveSecretsRuntimeSnapshotRevision(),
        }),
        applyHotReload: handlers.applyHotReload,
        hasPendingModelRuntimeReload: handlers.hasPendingModelRuntimeReload,
      });
      const readIntervals = async () =>
        (await loadCronJobsStore(cronState.storePath)).jobs
          .filter((job) => job.payload.kind === "heartbeat")
          .toSorted((left, right) => (left.agentId ?? "").localeCompare(right.agentId ?? ""))
          .map((job) => (job.schedule.kind === "every" ? job.schedule.everyMs : undefined));
      try {
        await expect(cronState.reconcileSystemJobs()).resolves.toBe("converged");
        publicationFailure.install();
        const result = await managed
          .onHotReload(
            buildGatewayReloadPlan(["agents.entries.first.heartbeat.every"]),
            nextConfig,
            ownership,
            nextConfig,
          )
          .catch((error: unknown) => error);
        expect(await readIntervals()).toEqual([7_200_000, 3_600_000]);
        expect(result).toBe("applied");
        expect(requestRecoveryRestart).not.toHaveBeenCalled();
        expect(markRuntimeCommitted).toHaveBeenCalledOnce();
        expect(getActiveSecretsRuntimeSnapshot()?.config).toEqual(nextConfig);
        publicationFailure.remove();
        const successorConfig = { ...nextConfig, logging: { level: "debug" as const } };
        if (successor === "rejected") {
          await expect(
            managed.onHotReload(
              buildGatewayReloadPlan(["logging.level"]),
              successorConfig,
              { ...ownership, isCurrent: () => false },
              successorConfig,
            ),
          ).rejects.toThrow("superseded");
        } else {
          await expect(
            managed.onHotReload(
              buildGatewayReloadPlan([]),
              successorConfig,
              ownership,
              successorConfig,
            ),
          ).resolves.toBe("applied");
        }
        await clock.advanceBy(30_000);
        expect(await readIntervals()).toEqual([7_200_000, 7_200_000]);
        expect(requestRecoveryRestart).not.toHaveBeenCalled();
      } finally {
        try {
          publicationFailure.dispose();
        } finally {
          handlers.stopRestartRetries();
          cronState.cron.stop();
          await scheduler.stop();
        }
      }
    },
  );

  it.each(["converged", "lifecycle-deferred", "retry-scheduled", "rejected"] as const)(
    "preserves cron reconciliation recovery semantics for %s",
    async (result) => {
      const logReload = { info: vi.fn(), warn: vi.fn() };
      const { requestRecoveryRestart, restartEmitted } = createRecoveryRestartMock();
      const reconcileSystemJobs = vi.fn<GatewayCronState["reconcileSystemJobs"]>();
      let state = createDefaultGatewayReloadState({
        cronState: createTestCronState({ reconcileSystemJobs }),
      });
      const handlers = createGatewayReloadHandlers({
        getState: () => state,
        setState: (nextState) => {
          state = nextState;
        },
        logReload,
        requestRecoveryRestart,
      });
      if (result === "rejected") {
        reconcileSystemJobs.mockRejectedValueOnce(new Error("cron reconciliation failed"));
      } else {
        reconcileSystemJobs.mockResolvedValueOnce(result);
      }
      try {
        await expect(
          handlers.applyHotReload(buildGatewayReloadPlan(["agents.defaults.heartbeat.every"]), {
            agents: { defaults: { heartbeat: { every: "1h" } } },
          }),
        ).resolves.toBe(result === "rejected" ? "applied-restart-required" : "applied");
        if (result === "rejected") {
          await restartEmitted;
          expect(requestRecoveryRestart).toHaveBeenCalledOnce();
        } else {
          expect(requestRecoveryRestart).not.toHaveBeenCalled();
        }
        if (result === "retry-scheduled") {
          expect(logReload.warn).toHaveBeenCalledWith(
            "cron system jobs pending; continuing hot reload with cron retry",
          );
        }
      } finally {
        handlers.stopRestartRetries();
      }
    },
  );
}
