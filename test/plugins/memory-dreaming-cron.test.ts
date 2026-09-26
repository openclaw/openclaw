import { afterEach, expect, it, vi } from "vitest";
import memoryCore from "../../extensions/memory-core/index.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import { resolveCronJobEffectiveAgentId } from "../../src/cron/agent-id.js";
import { CronService } from "../../src/cron/service.js";
import { createCronStoreHarness, createNoopLogger } from "../../src/cron/service.test-harness.js";
import { createTestPluginApi } from "../../src/plugin-sdk/plugin-test-api.js";
import { createPluginRuntimeMock } from "../../src/plugin-sdk/test-helpers/plugin-runtime-mock.js";
import { createEmptyPluginRegistry } from "../../src/plugins/registry.js";
import { startPluginServices, type PluginServicesHandle } from "../../src/plugins/services.js";
import { createTestGatewayScheduler } from "../../src/test-utils/gateway-scheduler-clock.js";

const { makeStorePath } = createCronStoreHarness({ prefix: "memory-dreaming-cron-" });
const services = new Set<PluginServicesHandle>();
const schedulers = new Set<CronService>();

afterEach(async () => {
  await Promise.all([...services].map((service) => service.stop()));
  services.clear();
  for (const cron of schedulers) {
    cron.stop();
  }
  schedulers.clear();
  vi.useRealTimers();
});

function registerDreaming(config: OpenClawConfig, logger: ReturnType<typeof createNoopLogger>) {
  const registry = createEmptyPluginRegistry();
  memoryCore.register(
    createTestPluginApi({
      config,
      logger,
      runtime: createPluginRuntimeMock({ config: { current: () => config } }),
      registerService(service) {
        registry.services.push({
          pluginId: "memory-core",
          origin: "bundled",
          source: "memory-core/index.ts",
          id: service.id,
          service,
        });
      },
    }),
  );
  return registry;
}

async function createScheduler(cronEnabled: boolean, owner?: string) {
  const { storePath } = await makeStorePath();
  const cron = new CronService({
    scheduler: createTestGatewayScheduler(),
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

it.each([false, true])(
  "does not author ownerless dreaming work when effective scheduling is disabled (config enabled=%s)",
  async (configEnabled) => {
    vi.useFakeTimers();
    const config: OpenClawConfig = {
      agents: { ownership: "explicit", list: [{ id: "qa" }, { id: "qa-extra" }] },
      cron: { enabled: configEnabled },
    };
    const cron = await createScheduler(false);
    const add = vi.spyOn(cron, "add");
    const logger = createNoopLogger();
    const registry = registerDreaming(config, logger);
    const handle = await startPluginServices({ registry, config, getCronService: () => cron });
    services.add(handle);

    expect(logger.error).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(logger.error).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
    expect(await cron.list({ includeDisabled: true })).toEqual([]);
  },
);

it("creates one owned declaration after scheduling resumes and across service reload", async () => {
  const config: OpenClawConfig = {
    agents: {
      ownership: "explicit",
      defaults: { systemAgent: { agentId: "qa" } },
      list: [{ id: "qa" }, { id: "qa-extra" }],
    },
  };
  let cron = await createScheduler(false, "qa");
  const logger = createNoopLogger();
  const handle = await startPluginServices({
    registry: registerDreaming(config, logger),
    config,
    getCronService: () => cron,
  });
  services.add(handle);
  expect(await cron.list({ includeDisabled: true })).toEqual([]);

  cron = await createScheduler(true, "qa");
  await handle.reload(config, new Set(["memory-core-dreaming"]));
  const jobs = await cron.list({ includeDisabled: true });
  expect(jobs).toMatchObject([
    {
      declarationKey: "memory-core:memory-dreaming-promotion",
      enabled: true,
      sessionTarget: "isolated",
      payload: { kind: "agentTurn" },
    },
  ]);
  expect(jobs).toHaveLength(1);
  expect(jobs.map((job) => resolveCronJobEffectiveAgentId(job, cron.getDefaultAgentId()))).toEqual([
    "qa",
  ]);

  await handle.reload(config, new Set(["memory-core-dreaming"]));
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
    const unrelated = await cron.add({ ...job, name: "Unrelated maintenance" });
    const before = await cron.list({ includeDisabled: true });
    const config: OpenClawConfig = {
      agents: { ownership: "explicit", list: [{ id: "qa" }, { id: "qa-extra" }] },
      plugins: {
        entries: { "memory-core": { config: { dreaming: { enabled: dreamingEnabled } } } },
      },
    };
    const logger = createNoopLogger();
    const handle = await startPluginServices({
      registry: registerDreaming(config, logger),
      config,
      getCronService: () => cron,
    });
    services.add(handle);

    expect(await cron.list({ includeDisabled: true })).toEqual(
      dreamingEnabled ? before : before.filter((entry) => entry.id !== managed.id),
    );
    expect(
      (await cron.list({ includeDisabled: true })).some((entry) => entry.id === unrelated.id),
    ).toBe(true);
    expect(logger.error).not.toHaveBeenCalled();
  },
);
