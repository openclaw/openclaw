import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CronService } from "../cron/service.js";
import { createCronStoreHarness, createNoopLogger } from "../cron/service.test-harness.js";
import { loadCronStore } from "../cron/store.js";
import { getGatewayProcessInstanceId } from "../gateway/process-instance.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { resolveRuntimeServiceBuildId } from "../version.js";
import {
  createRegistry,
  startPluginServices,
  type PluginServicesHandle,
} from "./services.test-support.js";
import type { OpenClawPluginServiceContext } from "./types.js";

const { makeStorePath } = createCronStoreHarness({ prefix: "plugin-service-cron-" });
const handles = new Set<PluginServicesHandle>();
const schedulers = new Set<CronService>();
const family = {
  declarationKey: "test-plugin:maintenance",
  name: "Plugin maintenance",
  ownerPluginTag: "[managed-by=test-plugin]",
};

afterEach(async () => {
  await Promise.all([...handles].map((handle) => handle.stop()));
  handles.clear();
  for (const cron of schedulers) {
    cron.stop();
  }
  schedulers.clear();
});

async function createScheduler() {
  const { storePath } = await makeStorePath();
  const cron = new CronService({
    scheduler: createTestGatewayScheduler(),
    nowMs: () => Date.now(),
    storePath,
    cronEnabled: false,
    log: createNoopLogger(),
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
  });
  schedulers.add(cron);
  return { cron, storePath };
}

async function startService(getCronService?: () => CronService) {
  let context: OpenClawPluginServiceContext | undefined;
  const registry = createRegistry(
    [
      {
        id: "maintenance",
        start: (ctx) => {
          context = ctx;
        },
      },
    ],
    "test-plugin",
  );
  const handle = await startPluginServices({ registry, config: {}, getCronService });
  handles.add(handle);
  return { context: expectDefined(context, "started service context"), handle };
}

function createJob(name = family.name) {
  return {
    declarationKey: family.declarationKey,
    name,
    description: family.ownerPluginTag,
    enabled: false,
    schedule: { kind: "cron" as const, expr: "0 2 * * *" },
    sessionTarget: "main" as const,
    wakeMode: "now" as const,
    payload: { kind: "systemEvent" as const, text: "maintenance" },
  };
}

describe("plugin service scheduler ownership", () => {
  it("keeps one handle per scheduler and reconciles through a successor service", async () => {
    const { cron } = await createScheduler();
    const first = await startService(() => cron);
    const service = expectDefined(first.context.getCron?.(), "Gateway scheduler");
    expect(first.context.getCron?.()).toBe(service);
    const isEnabled = expectDefined(service.isEnabled, "scheduler enabled observation");
    expect(await isEnabled()).toBe(false);
    await service.add(createJob());
    await first.handle.stop();
    expect(() => first.context.getCron?.()).toThrow("no longer active");
    await expect(service.list()).rejects.toThrow("no longer active");
    await expect(isEnabled()).rejects.toThrow("no longer active");
    await expect(
      expectDefined(service.enqueueRun, "service run admission")("retained", "if-enabled"),
    ).rejects.toThrow("no longer active");

    const next = await startService(() => cron);
    const successor = expectDefined(next.context.getCron?.(), "replacement scheduler");
    const job = expectDefined(
      (await successor.list({ includeDisabled: true }))[0],
      "managed plugin job",
    );
    expect(job).toMatchObject({ declarationKey: family.declarationKey });
    await successor.update(job.id, { schedule: { kind: "cron", expr: "0 3 * * *" } });
    expect(await successor.list({ includeDisabled: true })).toMatchObject([
      { id: job.id, schedule: { expr: "0 3 * * *" } },
    ]);
  });

  it.each(["service stop", "scheduler replacement"] as const)(
    "rejects reads and writes queued before %s without changing stored rows",
    async (retirement) => {
      const original = await createScheduler();
      const replacement = await createScheduler();
      const job = await original.cron.add({ ...createJob(), enabled: true });
      let current = original.cron;
      const { context, handle } = await startService(() => current);
      const service = expectDefined(context.getCron?.(), "Gateway scheduler");
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const blocker = original.cron.updateWithPrecondition(job.id, {}, async () => {
        entered.resolve();
        await release.promise;
      });
      await entered.promise;
      const queued = [
        expectDefined(service.isEnabled, "scheduler enabled observation")(),
        service.list({ includeDisabled: true }),
        service.add({ ...createJob("late addition"), declarationKey: "test-plugin:late" }),
        service.update(job.id, { name: "late update" }),
        service.remove(job.id),
        service.removeStaleJobFamily(family),
        expectDefined(service.enqueueRun, "service run admission")(job.id, "if-enabled"),
      ];
      const results = Promise.allSettled(queued);
      let stopping: ReturnType<PluginServicesHandle["stop"]> | undefined;
      try {
        if (retirement === "scheduler replacement") {
          current = replacement.cron;
          expect(context.getCron?.()).not.toBe(service);
        } else {
          stopping = handle.stop();
          expect(() => context.getCron?.()).toThrow("stopping");
        }
      } finally {
        release.resolve();
        await stopping;
        await blocker;
        await results;
      }
      expect((await results).map((result) => result.status)).toEqual(Array(7).fill("rejected"));
      expect((await loadCronStore(original.storePath)).jobs).toMatchObject([
        { id: job.id, name: family.name },
      ]);
      expect((await loadCronStore(replacement.storePath)).jobs).toHaveLength(0);
    },
  );
});

it("shares the canonical runtime identity only while the exporter lease is active", async () => {
  let readIdentity: NonNullable<
    OpenClawPluginServiceContext["internalDiagnostics"]
  >["getRuntimeIdentity"];
  const registry = createRegistry(
    [
      {
        id: "diagnostics-prometheus",
        start: (ctx) => {
          readIdentity = ctx.internalDiagnostics?.getRuntimeIdentity;
        },
      },
    ],
    "diagnostics-prometheus",
    "bundled",
  );
  const handle = await startPluginServices({
    registry,
    config: {},
    onHandle: (issued) => handles.add(issued),
  });
  const buildId = resolveRuntimeServiceBuildId();
  expect(readIdentity?.()).toEqual({
    processInstanceId: getGatewayProcessInstanceId(),
    ...(buildId ? { buildId } : {}),
  });
  await handle.stop();
  expect(() => readIdentity?.()).toThrow("no longer active");
});
