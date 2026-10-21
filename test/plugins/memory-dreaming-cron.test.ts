import { afterEach, beforeEach, expect, it, vi } from "vitest";
import memoryCore from "../../extensions/memory-core/index.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import { resolveCronJobEffectiveAgentId } from "../../src/cron/agent-id.js";
import { CronService } from "../../src/cron/service.js";
import { createCronStoreHarness, createNoopLogger } from "../../src/cron/service.test-harness.js";
import { createPluginRuntimeMock } from "../../src/plugin-sdk/test-helpers/plugin-runtime-mock.js";
import { startPluginServices, type PluginServicesHandle } from "../../src/plugins/services.js";
import { createTestGatewayScheduler } from "../../src/test-utils/gateway-scheduler-clock.js";
import { createServiceRegistry } from "./service-registry.test-support.js";

const { makeStorePath } = createCronStoreHarness({ prefix: "memory-dreaming-cron-" });
const services = new Set<PluginServicesHandle>();
const schedulers = new Set<CronService>();
let scheduler: ReturnType<typeof createTestGatewayScheduler>;

beforeEach(() => {
  scheduler = createTestGatewayScheduler();
});

afterEach(async () => {
  scheduler.beginClose();
  try {
    await Promise.all([...services].map((service) => service.stop()));
  } finally {
    services.clear();
    for (const cron of schedulers) {
      cron.stop();
    }
    schedulers.clear();
    await scheduler.stop();
    vi.useRealTimers();
  }
});

async function startDreaming(config: OpenClawConfig, getCronService: () => CronService) {
  const logger = createNoopLogger();
  const backgroundTasks: Promise<unknown>[] = [];
  const { api, registry } = createServiceRegistry("memory-core", {
    id: "test-plugin",
    config,
    logger,
    runtime: createPluginRuntimeMock({ config: { current: () => config } }),
  });
  api.lifecycle.runInBackgroundContext = (run) => {
    const result = run();
    if (result instanceof Promise) {
      backgroundTasks.push(result);
    }
    return result;
  };
  memoryCore.register(api);
  const settleStartup = () => Promise.all(backgroundTasks);
  const handle = await startPluginServices({ scheduler, registry, config, getCronService });
  services.add(handle);
  await settleStartup();
  return { handle, logger, settleStartup };
}

async function createScheduler(cronEnabled: boolean, owner?: string) {
  const { storePath } = await makeStorePath();
  const cron = new CronService({
    scheduler,
    nowMs: () => Date.now(),
    storePath,
    cronEnabled,
    resolveDefaultAgentId: () => owner,
    log: createNoopLogger(),
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
  });
  schedulers.add(cron);
  return cron;
}

function dreamingConfig(overrides: OpenClawConfig = {}): OpenClawConfig {
  const agents: OpenClawConfig["agents"] = {
    ownership: "explicit",
    entries: { qa: {}, "qa-extra": {} },
    ...overrides.agents,
  };
  return { ...overrides, agents };
}

it("does not author ownerless dreaming work when the scheduler overrides enabled config", async () => {
  vi.useFakeTimers();
  const config = dreamingConfig({ cron: { enabled: true } });
  const cron = await createScheduler(false);
  const add = vi.spyOn(cron, "add");
  const { logger } = await startDreaming(config, () => cron);

  await vi.advanceTimersByTimeAsync(60_000);
  expect(logger.error).not.toHaveBeenCalled();
  expect(add).not.toHaveBeenCalled();
  expect(await cron.list({ includeDisabled: true })).toEqual([]);
});

it("creates one owned declaration after scheduling resumes and across service reload", async () => {
  const config = dreamingConfig({
    agents: { defaults: { systemAgent: { agentId: "qa" } } },
  });
  let cron = await createScheduler(false, "qa");
  const { handle, logger, settleStartup } = await startDreaming(config, () => cron);
  expect(await cron.list({ includeDisabled: true })).toEqual([]);

  cron = await createScheduler(true, "qa");
  await handle.reload(config, new Set(["memory-core-dreaming"]));
  await settleStartup();
  const jobs = await cron.list({ includeDisabled: true });
  expect(jobs).toHaveLength(1);
  expect(jobs[0]).toMatchObject({
    declarationKey: "memory-core:memory-dreaming-promotion",
    enabled: true,
    sessionTarget: "isolated",
    payload: { kind: "agentTurn" },
  });
  expect(resolveCronJobEffectiveAgentId(jobs[0]!, cron.getDefaultAgentId())).toBe("qa");

  await handle.reload(config, new Set(["memory-core-dreaming"]));
  await settleStartup();
  expect((await cron.list({ includeDisabled: true })).map((job) => job.id)).toEqual(
    jobs.map((job) => job.id),
  );
  expect(logger.error).not.toHaveBeenCalled();
});

it.each([true, false])(
  "preserves paused jobs unless dreaming itself is disabled (dreaming enabled=%s)",
  async (dreamingEnabled) => {
    const cron = await createScheduler(false);
    const job = {
      agentId: "qa",
      enabled: false,
      schedule: { kind: "cron" as const, expr: "0 2 * * *" },
      sessionTarget: "isolated" as const,
      wakeMode: "now" as const,
      payload: { kind: "agentTurn" as const, message: "maintenance" },
      delivery: { mode: "none" as const },
    };
    const managed = await cron.add({
      ...job,
      name: "Memory dreaming",
      declarationKey: "memory-core:memory-dreaming-promotion",
    });
    await cron.add({ ...job, name: "Unrelated maintenance" });
    const before = await cron.list({ includeDisabled: true });
    const config = dreamingConfig({
      plugins: {
        entries: { "memory-core": { config: { dreaming: { enabled: dreamingEnabled } } } },
      },
    });
    const { logger } = await startDreaming(config, () => cron);

    expect(await cron.list({ includeDisabled: true })).toEqual(
      dreamingEnabled ? before : before.filter((entry) => entry.id !== managed.id),
    );
    expect(logger.error).not.toHaveBeenCalled();
  },
);
