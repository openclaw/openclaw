import { expect, vi } from "vitest";
import { createDueIsolatedJob } from "../../../test/helpers/cron/service-regression-fixtures.js";
import { setRuntimeConfigSnapshot } from "../../config/config.js";
import { DEFAULT_CRON_MAX_CONCURRENT_RUNS } from "../../config/cron-limits.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  createCoreGatewayMethodDescriptors,
  createGatewayMethodRegistry,
} from "../../gateway/methods/registry.js";
import { cronHandlers } from "../../gateway/server-methods/cron.js";
import type { GatewayRequestContext } from "../../gateway/server-methods/types.js";
import { getTotalQueueSize } from "../../process/command-queue.js";
import { resetCommandQueueStateForTest } from "../../process/command-queue.test-support.js";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { CronService, type CronEvent } from "../service.js";
import { createNoopLogger } from "../service.test-harness.js";
import { loadCronStore, saveCronStore } from "../store.js";
import type { CronServiceDeps } from "./state.js";

export type CronGatewayFixture = Parameters<Parameters<typeof withCronGatewayState>[0]>[0];

export async function withCronGatewayState(
  run: (fixture: {
    cfg: OpenClawConfig;
    context: GatewayRequestContext;
    storePath: string;
    cron: CronService;
    logger: ReturnType<typeof createNoopLogger>;
    runIsolatedAgentJob: CronServiceDeps["runIsolatedAgentJob"];
    finished: (jobId: string) => Promise<CronEvent>;
    settle: () => Promise<void>;
  }) => Promise<void>,
  listConfiguredChannels?: CronServiceDeps["listConfiguredChannels"],
  authenticate = false,
) {
  await withOpenClawTestState({ prefix: "cron-gateway-" }, async (state) => {
    resetCommandQueueStateForTest();
    const cfg: OpenClawConfig = {
      agents: {
        entries: { main: {} },
        defaults: {
          workspace: state.workspaceDir,
          ...(authenticate ? { model: "openai/gpt-4.1" } : {}),
        },
      },
      cron: { enabled: false },
    };
    if (authenticate) {
      await state.writeAuthProfiles({
        version: 1,
        profiles: {
          "openai:mutation-fixture": {
            type: "api_key",
            provider: "openai",
            key: "synthetic-mutation-inference-key",
          },
        },
      });
    }
    await state.writeConfig(cfg);
    setRuntimeConfigSnapshot(cfg);
    const storePath = state.statePath("cron", "jobs.json");
    await saveCronStore(storePath, { version: 1, jobs: [] });
    const logger = createNoopLogger();
    const finishedJobs = new Map<string, ReturnType<typeof createDeferredCore<CronEvent>>>();
    const finished = (id: string) => {
      let entry = finishedJobs.get(id);
      if (!entry) {
        entry = createDeferredCore<CronEvent>();
        finishedJobs.set(id, entry);
      }
      return entry;
    };
    const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const }));
    const cron = new CronService({
      scheduler: createTestGatewayScheduler(),
      storePath,
      cronEnabled: false,
      defaultAgentId: "main",
      log: logger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob,
      listConfiguredChannels,
      onEvent: (event) => {
        if (event.action === "finished") {
          finished(event.jobId).resolve(event);
        }
      },
    });
    const registry = createGatewayMethodRegistry(createCoreGatewayMethodDescriptors(cronHandlers));
    const gatewayWork = new AsyncWorkScope();
    const context = {
      cron,
      cronStorePath: storePath,
      trackExecution: gatewayWork.track.bind(gatewayWork),
      deps: {},
      getRuntimeConfig: () => cfg,
      getGatewayMethodRegistry: () => registry,
      logGateway: createNoopLogger(),
    } as unknown as GatewayRequestContext;
    context.resolveGatewayContext = () => context;
    try {
      await run({
        cfg,
        context,
        storePath,
        cron,
        logger,
        runIsolatedAgentJob,
        finished: (id) => finished(id).promise,
        settle: () => gatewayWork.runWhenIdle(() => undefined),
      });
    } finally {
      cron.stop();
      await cron.waitForIdle();
      await gatewayWork.drain();
      await vi.waitFor(() => expect(getTotalQueueSize()).toBe(0));
      resetCommandQueueStateForTest();
    }
  });
}

export async function occupyWorkers(
  fixture: CronGatewayFixture,
  job: ReturnType<typeof createDueIsolatedJob>,
  runTarget: NonNullable<CronServiceDeps["runIsolatedAgentJob"]> = async () => ({ status: "ok" }),
) {
  const now = job.createdAtMs;
  const blockerJobs = Array.from({ length: DEFAULT_CRON_MAX_CONCURRENT_RUNS }, (_, index) =>
    createDueIsolatedJob({ id: `capacity-${index}`, nowMs: now, nextRunAtMs: now }),
  );
  await saveCronStore(fixture.storePath, { version: 1, jobs: [...blockerJobs, job] });
  const started = createDeferredCore();
  const releaseBlocker = createDeferredCore();
  let count = 0;
  vi.mocked(fixture.runIsolatedAgentJob).mockImplementation(async (input) => {
    if (input.job.id === job.id) {
      return await runTarget(input);
    }
    if (++count === blockerJobs.length) {
      started.resolve();
    }
    await releaseBlocker.promise;
    return { status: "ok" };
  });
  const blocker = Promise.all(blockerJobs.map((entry) => fixture.cron.run(entry.id, "force")));
  await started.promise;
  const targetCalls = () =>
    vi.mocked(fixture.runIsolatedAgentJob).mock.calls.filter(([input]) => input.job.id === job.id);
  return { blocker, releaseBlocker, targetCalls };
}

export async function readJob(fixture: CronGatewayFixture, id: string) {
  return (await loadCronStore(fixture.storePath)).jobs.find((entry) => entry.id === id);
}
