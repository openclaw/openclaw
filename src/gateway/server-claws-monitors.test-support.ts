import fs from "node:fs/promises";
import { afterEach, expect, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  withAgentDeletion,
  isAgentDeletionBlocked,
  type AgentDeletionOperation,
} from "../agents/agent-lifecycle-registry.js";
import { listAgentEntries } from "../agents/agent-scope.js";
import { applyClawAddPlan } from "../claws/add.js";
import type { ClawRemoveApplyOptions } from "../claws/lifecycle-remove-contract.js";
import { applyClawRemovePlan, buildClawRemovePlan } from "../claws/lifecycle-state.js";
import { buildClawAddPlan } from "../claws/lifecycle.js";
import { resolveClawMonitorCleanupBinding } from "../claws/monitor-cleanup-binding.js";
import {
  clawMonitorInventorySchema,
  type ClawMonitorCleanupGateway,
} from "../claws/monitor-cleanup-contract.js";
import { parseClawManifest } from "../claws/schema.js";
import { registerConfigWriteListener, resetConfigRuntimeState } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { applyHeartbeatMonitorJobs } from "../cron/heartbeat-monitor.js";
import { cronJobReadView } from "../cron/job-read-view.js";
import { normalizeCronJobCreate } from "../cron/normalize.js";
import { CronService } from "../cron/service.js";
import type { CronServiceDeps } from "../cron/service/state.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import * as sleep from "../utils/sleep.js";
import { reconcileSkillCollectionReviewJobs } from "./server-cron-skill-review-jobs.js";
import { clawsMonitorHandlers } from "./server-methods/claws-monitors.js";
import type { RespondFn } from "./server-methods/types.js";

// Advance only registered sleeps so asynchronous setup cannot spend the drain deadline.
export async function withMonitorDrainClock<T>(run: () => Promise<T>): Promise<T> {
  const originalSleep = sleep.sleep;
  let sleeping = createDeferred<number>();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const observation = vi.spyOn(sleep, "sleep").mockImplementation((delay, signal) => {
    const pending = originalSleep(delay, signal);
    sleeping.resolve(delay);
    return pending;
  });
  try {
    const result = run();
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    for (;;) {
      const delay = await Promise.race([sleeping.promise, settled]);
      if (delay === undefined) {
        return await result;
      }
      sleeping = createDeferred<number>();
      await vi.advanceTimersByTimeAsync(delay);
    }
  } finally {
    observation.mockRestore();
    vi.useRealTimers();
  }
}

export function useClawMonitorFixture() {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).toReversed()) {
      await cleanup();
    }
  });

  return async function fixture(
    enabled: boolean,
    runner?: CronServiceDeps["runIsolatedAgentJob"],
    withCron = false,
  ) {
    const state = await createOpenClawTestState({ label: "claw-monitor-removal" });
    cleanups.push(state.cleanup);
    await fs.writeFile(state.path("SOUL.md"), "synthetic managed file\n");
    const parsed = parseClawManifest({
      schemaVersion: 1,
      agent: { id: "worker", name: "Worker" },
      workspace: { bootstrapFiles: { "SOUL.md": { source: "SOUL.md" } } },
      cronJobs: withCron
        ? [
            {
              id: "daily",
              schedule: { cron: "0 9 * * *", timezone: "UTC" },
              session: "isolated",
              message: "synthetic daily task",
            },
          ]
        : [],
    });
    if (!parsed.ok) {
      throw new Error("Invalid synthetic Claw fixture.");
    }
    const workspaceDir = state.path("claw-workspace");
    const addPlan = await buildClawAddPlan({
      manifest: parsed.manifest,
      source: {
        kind: "package",
        name: "synthetic-worker",
        version: "1.0.0",
        packageRoot: state.root,
        manifestPath: state.path("openclaw.claw.json"),
        integrityKind: "artifact",
        integrity: "sha256:synthetic",
        byteLength: 100,
      },
      context: { workspace: workspaceDir },
    });
    expect(addPlan.blockers).toEqual([]);
    let config: OpenClawConfig = {
      agents: { defaults: { heartbeat: { every: enabled ? "30m" : "0m" } } },
      skills: { workshop: { autonomous: { mode: enabled ? "auto" : "off" } } },
    };
    const storePath = state.statePath("cron", "jobs.json");
    const cronDeps: CronServiceDeps = {
      scheduler: createTestGatewayScheduler(),
      nowMs: () => Date.now(),
      storePath,
      cronEnabled: false,
      log: logger,
      defaultAgentId: "worker",
      resolveSessionStorePath: (agentId = "worker") =>
        state.statePath("agents", agentId, "sessions", "sessions.json"),
      resolveDefaultAgentId: () => listAgentEntries(config)[0]?.id ?? "main",
      isAgentAvailable: (agentId) =>
        !isAgentDeletionBlocked(agentId) &&
        listAgentEntries(config).some((agent) => agent.id === agentId),
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: runner ?? vi.fn(async () => ({ status: "ok" as const })),
    };
    const cron = new CronService(cronDeps);
    cleanups.push(async () => {
      cron.stop();
    });
    await applyClawAddPlan(addPlan, {
      consentPlanIntegrity: addPlan.planIntegrity,
      commitConfig: async (transform) => {
        config = transform(config);
        await state.writeConfig(config);
        resetConfigRuntimeState();
      },
      cronGateway: {
        add: async (input) => {
          const normalized = normalizeCronJobCreate(input);
          if (!normalized) {
            throw new Error("Invalid synthetic cron input");
          }
          return { id: (await cron.add(normalized)).id };
        },
      },
    });
    let reconcilePending = false;
    const reconcile = async () => {
      expect((await applyHeartbeatMonitorJobs({ cron, cfg: config })).ok).toBe(true);
      expect(
        (await reconcileSkillCollectionReviewJobs({ cron, cfg: config, logger })).ok,
        JSON.stringify(logger.warn.mock.calls.slice(-3)),
      ).toBe(true);
      reconcilePending = false;
    };
    await reconcile();
    const unsubscribe = registerConfigWriteListener((event) => {
      if (event.configPath === state.configPath) {
        config = event.runtimeConfig;
        reconcilePending = true;
      }
    });
    cleanups.push(async () => unsubscribe());
    let reloadSettled = true;
    const context = {
      cron,
      cronStorePath: storePath,
      getRuntimeConfig: () => config,
      isConfigReloadSettled: () => reloadSettled,
    };
    const invoke = async (params: Record<string, unknown>) => {
      let response: unknown;
      let failure: string | undefined;
      const respond: RespondFn = (ok, payload, error) => {
        if (ok) {
          response = payload;
        } else {
          failure = error?.message ?? "Gateway refusal";
        }
      };
      await clawsMonitorHandlers["claws.monitors"]({
        params: { binding: resolveClawMonitorCleanupBinding(storePath), ...params },
        context,
        respond,
      });
      if (failure) {
        throw new Error(failure);
      }
      return response;
    };
    const gateway: ClawMonitorCleanupGateway = {
      inspect: async (agentId) =>
        clawMonitorInventorySchema.parse(await invoke({ phase: "inspect", agentId })).monitors,
      quiesce: async (agentId, operationId, monitors) => {
        await invoke({ phase: "quiesce", agentId, operationId, monitors });
      },
      drain: async (agentId, operationId) => {
        if (reconcilePending) {
          await reconcile();
        }
        await invoke({ phase: "drain", agentId, operationId });
      },
    };
    const writeConfig = async (nextConfig: OpenClawConfig) => {
      config = nextConfig;
      await state.writeConfig(config);
      resetConfigRuntimeState();
      await reconcile();
    };
    const plan = () => buildClawRemovePlan("worker", { config, monitorGateway: gateway });
    const apply = async (
      removal: Awaited<ReturnType<typeof plan>>,
      overrides: Partial<ClawRemoveApplyOptions> = {},
    ) =>
      applyClawRemovePlan(removal, {
        config,
        monitorGateway: gateway,
        cronGateway: {
          get: async (id) => {
            const job = await cron.readJob(id);
            return job ? cronJobReadView(job) : null;
          },
          remove: async (id) => await cron.remove(id),
        },
        trashPath: async (pathname) => {
          await fs.rm(pathname, { recursive: true, force: true });
          return true;
        },
        consentPlanIntegrity: removal.planIntegrity,
        ...overrides,
      });
    return {
      state,
      workspaceDir,
      cron,
      gateway,
      plan,
      apply,
      invoke,
      writeConfig,
      reconcile,
      replaceCron: () => {
        const replacement = new CronService(cronDeps);
        context.cron = replacement;
        cleanups.push(async () => {
          replacement.stop();
        });
      },
      getConfig: () => config,
      withDeletion: <T>(run: (deletion: AgentDeletionOperation) => Promise<T>) =>
        withAgentDeletion("worker", async (begin) =>
          run(
            begin({
              agentId: "worker",
              agentDir: state.agentDir("worker"),
              workspaceDir,
              sessionsDir: state.sessionsDir("worker"),
              deleteFiles: false,
            }),
          ),
        ),
      setReloadSettled: (value: boolean) => {
        reloadSettled = value;
      },
    };
  };
}
