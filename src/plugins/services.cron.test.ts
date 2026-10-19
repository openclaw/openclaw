import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import { CronService } from "../cron/service.js";
import { createCronStoreHarness, createNoopLogger } from "../cron/service.test-harness.js";
import { loadCronStore } from "../cron/store.js";
import { getGatewayProcessInstanceId } from "../gateway/process-instance.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { resolveRuntimeServiceBuildId } from "../version.js";
import type { PluginServiceRegistration } from "./registry-types.js";
import {
  createRegistry,
  createServiceRegistration,
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

function capturingRegistry(
  pluginIds: string[],
  id = "maintenance",
  origin: PluginServiceRegistration["origin"] = "workspace",
) {
  const registry = createRegistry([]);
  const contexts = new Map<string, OpenClawPluginServiceContext>();
  for (const pluginId of pluginIds) {
    registry.services.push(
      createServiceRegistration(
        {
          id,
          start: (context) => {
            contexts.set(pluginId, context);
          },
        },
        { pluginId, origin },
      ),
    );
  }
  return { registry, contexts };
}

async function startService(getCronService: () => CronService) {
  const { registry, contexts } = capturingRegistry(["test-plugin"]);
  const handle = await startPluginServices({ registry, config: {}, getCronService });
  handles.add(handle);
  const context = expectDefined(contexts.get("test-plugin"), "started service context");
  return { context, handle, service: expectDefined(context.getCron?.(), "Gateway scheduler") };
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

it("keeps one handle per scheduler and reconciles through a successor service", async () => {
  const { cron } = await createScheduler();
  const first = await startService(() => cron);
  const { service } = first;
  expect(first.context.getCron?.()).toBe(service);
  const isEnabled = expectDefined(service.isEnabled, "scheduler enabled observation");
  expect(await isEnabled()).toBe(false);
  await service.add(createJob());
  await first.handle.stop();
  expect(() => first.context.getCron?.()).toThrow("no longer active");
  await Promise.all(
    [
      service.list(),
      isEnabled(),
      expectDefined(service.enqueueRun, "service run admission")("retained", "if-enabled"),
    ].map((read) => expect(read).rejects.toThrow("no longer active")),
  );

  const { service: successor } = await startService(() => cron);
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
    const { context, handle, service } = await startService(() => current);
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

it("shares the canonical runtime identity only while the exporter lease is active", async () => {
  const { registry, contexts } = capturingRegistry(
    ["diagnostics-prometheus"],
    "diagnostics-prometheus",
    "bundled",
  );
  const handle = await startPluginServices({
    registry,
    config: {},
    onHandle: (issued) => handles.add(issued),
  });
  const readIdentity =
    contexts.get("diagnostics-prometheus")?.internalDiagnostics?.getRuntimeIdentity;
  const buildId = resolveRuntimeServiceBuildId();
  expect(readIdentity?.()).toEqual({
    processInstanceId: getGatewayProcessInstanceId(),
    ...(buildId ? { buildId } : {}),
  });
  await handle.stop();
  expect(() => readIdentity?.()).toThrow("no longer active");
});

it("isolates service deadlines and joins admitted work before retiring its owner", async () => {
  const clock = createGatewaySchedulerClock(100);
  const scheduler = createTestGatewayScheduler(clock.clock);
  const { registry, contexts } = capturingRegistry(["source-a", "source-b"], "events", "bundled");
  const handle = await startPluginServices({ registry, config: {}, scheduler });
  handles.add(handle);
  const first = expectDefined(contexts.get("source-a")?.scheduler, "first source scheduler");
  const sibling = expectDefined(contexts.get("source-b")?.scheduler, "sibling source scheduler");
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const siblingFired = createDeferredCore();
  const callbackFinished = vi.fn();
  first.schedule({
    id: "refresh",
    atMs: 200,
    run: async () => {
      entered.resolve();
      await release.promise;
      callbackFinished();
    },
  });
  sibling.schedule({ id: "refresh", atMs: 200, run: () => siblingFired.resolve() });
  try {
    const firing = clock.advanceTo(200);
    await Promise.all([entered.promise, siblingFired.promise]);
    const stopping = handle.stop({
      strict: true,
      deadlineAtMs: Date.now() + 5_000,
      pluginIds: new Set(["source-a"]),
    });
    expect([first.signal.aborted, sibling.signal.aborted]).toEqual([true, false]);
    expect(() => first.schedule({ id: "late", atMs: 300, run: () => {} })).toThrow();
    const stopFinished = vi.fn();
    void stopping.then(stopFinished);
    await Promise.resolve();
    expect(stopFinished).not.toHaveBeenCalled();
    expect(callbackFinished).not.toHaveBeenCalled();
    release.resolve();
    await stopping;
    await firing;
    expect(callbackFinished).toHaveBeenCalledOnce();
    const next = createDeferredCore();
    sibling.schedule({ id: "refresh", atMs: 300, run: () => next.resolve() });
    await clock.advanceTo(300);
    await next.promise;
  } finally {
    release.resolve();
    await handle.stop();
    await scheduler.stop();
  }
});
