import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createGatewayStartupTrace } from "../gateway/server-startup-trace.js";
import { resetDiagnosticEventsForTest } from "../infra/diagnostic-events.js";
import { resetDiagnosticTracePropagationForTest } from "../infra/diagnostic-trace-propagation.js";
import { resetDiagnosticStabilityRecorderForTest } from "../logging/diagnostic-stability.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { createDeferredCore } from "../shared/deferred.js";
import { registerPluginHttpRoute } from "./http-registry.js";
import { PluginInstance } from "./plugin-instance.js";
import { createEmptyPluginRegistry } from "./registry.js";
import { resetPluginRuntimeStateForTest } from "./runtime.js";
import { listPluginServiceHealthFailures } from "./service-health.js";
import {
  PLUGIN_SERVICE_REPLACEMENT_STOP_TIMEOUT_MS,
  type PluginServicesHandle,
} from "./services.js";
import { createRegistry, startPluginServices as startServices } from "./services.test-support.js";
import { createPluginRecord } from "./status.test-helpers.js";
import type { OpenClawPluginService, OpenClawPluginServiceContext } from "./types.js";

const handles = new Set<PluginServicesHandle>();
const releases: (() => void)[] = [];
const operations: Promise<unknown>[] = [];
const cleanup: (() => void)[] = [];
async function stopHandles() {
  for (const handle of [...handles].toReversed()) {
    await Promise.allSettled([handle.stop()]);
  }
}
afterEach(async () => {
  releases.splice(0).forEach((release) => release());
  const settled = Promise.allSettled(operations.splice(0));
  // Raw service cleanup must run before joining a plugin instance's retirement.
  await stopHandles();
  await settled;
  handles.clear();
  cleanup.splice(0).forEach((dispose) => dispose());
  vi.useRealTimers();
});

function deferred() {
  const result = createDeferredCore();
  releases.push(() => result.resolve());
  return result;
}

function track<T>(operation: Promise<T>): Promise<T> {
  operations.push(operation);
  return operation;
}

function starter(
  defaults: Omit<Parameters<typeof startServices>[0], "config" | "onHandle"> & {
    config?: OpenClawConfig;
  },
) {
  let current!: PluginServicesHandle;
  return {
    get current() {
      return current;
    },
    start: (overrides: Partial<typeof defaults> = {}) =>
      track(
        startServices({
          config: {},
          ...defaults,
          ...overrides,
          previous: current ?? defaults.previous,
          onHandle: (handle) => {
            handles.add(handle);
            current = handle;
          },
        }),
      ),
  };
}

function service(id: string, overrides: Partial<OpenClawPluginService> = {}) {
  const contexts: OpenClawPluginServiceContext[] = [];
  return {
    id,
    contexts,
    start: vi.fn((context: OpenClawPluginServiceContext) => {
      contexts.push(context);
      return overrides.start?.(context);
    }),
    stop: vi.fn(overrides.stop ?? (() => {})),
  };
}

function expectCalls(subject: ReturnType<typeof service>, ...counts: [number, number]) {
  expect([subject.start.mock.calls.length, subject.stop.mock.calls.length]).toEqual(counts);
}

function heldOperation() {
  const entered = deferred();
  const release = deferred();
  const run = vi.fn(async () => {
    entered.resolve();
    await release.promise;
  });
  return { entered, release, run };
}

function lateResource(event: string) {
  const { entered, release, run: wait } = heldOperation();
  const listener = () => {};
  const before = process.listenerCount(event);
  cleanup.push(() => {
    process.off(event, listener);
  });
  return {
    entered,
    release,
    wait,
    attach: () => process.on(event, listener),
    stop: vi.fn(() => {
      process.off(event, listener);
    }),
    expectClean: () => expect(process.listenerCount(event)).toBe(before),
  };
}

function emit(context: OpenClawPluginServiceContext | undefined, event: string) {
  context!.gatewayEvents!.emit(event, {}, { scope: "operator.read" });
}

const registryFor = (pluginId: string, ...services: Parameters<typeof createRegistry>[0]) =>
  createRegistry(services, pluginId);

function ownedServices(...services: OpenClawPluginService[]) {
  const registry = createEmptyPluginRegistry();
  registry.services = services.flatMap((entry) => registryFor(entry.id, entry).services);
  return registry;
}

const stopSelected = (handle: PluginServicesHandle, id: string) =>
  handle.stop({ strict: true, deadlineAtMs: Date.now() + 5_000, pluginIds: new Set([id]) });

describe("plugin service reload", () => {
  const configFor = (endpoint: string): OpenClawConfig => ({
    diagnostics: { otel: { enabled: true, endpoint } },
  });

  it("reloads selected services without changing sibling health or capabilities", async () => {
    const stops: OpenClawConfig[] = [];
    const broadcastPluginEvent = vi.fn();
    const exporter = service("exporter", {
      start() {
        registerPluginHttpRoute({ path: "/exporter", auth: "plugin", handler: vi.fn() });
      },
      stop(ctx) {
        stops.push(ctx.config);
      },
    });
    const sibling = service("sibling", {
      start: (ctx) => ctx.serviceHealth?.reportFailure(new Error("unrelated service failure")),
    });
    const { contexts } = exporter;
    const registry = ownedServices(exporter, { id: sibling.id, start: sibling.start });
    const first = configFor("https://first.example");
    const next = configFor("https://next.example");
    const final = configFor("https://final.example");
    const handle = await starter({ registry, config: first, broadcastPluginEvent }).start();
    await Promise.all([
      handle.reload(next, new Set(["exporter"])),
      handle.reload(final, new Set(["exporter"])),
    ]);
    expect(contexts.map((ctx) => ctx.config)).toEqual([first, next, final]);
    expect(stops).toEqual([first, next]);
    expect(sibling.start).toHaveBeenCalledOnce();
    expect(registry.httpRoutes).toHaveLength(1);
    expect(() => emit(contexts[0], "late")).toThrow("no longer active");
    contexts[0]?.serviceHealth?.reportFailure(new Error("retired exporter"));
    expect(listPluginServiceHealthFailures(registry)).toMatchObject([
      { pluginId: "sibling", error: "unrelated service failure" },
    ]);
    emit(sibling.contexts[0], "still_alive");
    expect(() => emit(contexts[1], "late")).toThrow("no longer active");
    emit(contexts[2], "replacement");
    expect(broadcastPluginEvent).toHaveBeenCalledTimes(2);
    await handle.stop();
    expect(stops).toEqual([first, next, final]);
    expect(registry.httpRoutes).toEqual([]);
  });

  it.each([
    "automatic",
    "retry",
    "handoff",
    "deferred-handoff",
    "shutdown",
    "selective-stop",
    "failed-cleanup",
  ] as const)("retains a timed-out reload until cleanup settles (%s)", async (recovery) => {
    vi.useFakeTimers();
    const entered = deferred();
    const release = deferred();
    const siblingStop = heldOperation();
    const restarted = deferred();
    let watching = false;
    const held = service("held", {
      start() {
        watching = true;
        if (held.contexts.length === 2) {
          restarted.resolve();
        }
      },
      async stop() {
        entered.resolve();
        await release.promise;
        watching = false;
      },
    });
    const { contexts } = held;
    const sibling = service("sibling", { stop: siblingStop.run });
    const handoff = recovery === "handoff" || recovery === "deferred-handoff";
    const registry = createRegistry(handoff ? [held, sibling] : [sibling, held], "reload-owner");
    const candidate = starter({
      registry,
      broadcastPluginEvent: vi.fn(),
    });
    const handle = await candidate.start();
    if (handoff) {
      siblingStop.release.resolve();
    }
    const next = configFor("https://next.example");
    const successorConfig = configFor("https://successor.example");
    const reloading = track(handle.reload(next, new Set([held.id, sibling.id])));
    let transfer: Promise<PluginServicesHandle> | undefined;
    await entered.promise;
    if (handoff) {
      transfer = candidate.start({
        config: successorConfig,
        ...(recovery === "deferred-handoff"
          ? { deferStartForPluginIds: new Set(["reload-owner"]) }
          : {}),
      });
    }
    await vi.advanceTimersByTimeAsync(PLUGIN_SERVICE_REPLACEMENT_STOP_TIMEOUT_MS);
    await siblingStop.entered.promise;
    siblingStop.release.resolve();
    await expect(reloading).resolves.toBeUndefined();
    await transfer;
    expectCalls(held, 1, 1);
    expect(watching).toBe(true);
    expect(sibling.start).toHaveBeenCalledTimes(recovery === "deferred-handoff" ? 1 : 2);
    expect(listPluginServiceHealthFailures(registry)).toMatchObject([
      {
        pluginId: "reload-owner",
        serviceId: "held",
        error: expect.stringContaining("timed out"),
      },
    ]);
    expect(() => emit(contexts[0], "stale")).toThrow("no longer active");
    if (recovery === "shutdown" || recovery === "selective-stop") {
      const stopping =
        recovery === "shutdown"
          ? candidate.current.stop()
          : candidate.current.stop({ strict: true, pluginIds: new Set(["reload-owner"]) });
      release.resolve();
      await stopping;
      await vi.advanceTimersByTimeAsync(0);
      expect(held.start).toHaveBeenCalledOnce();
      expect(watching).toBe(false);
    } else if (recovery === "failed-cleanup") {
      release.reject(new Error("cleanup refused"));
      await vi.advanceTimersByTimeAsync(0);
      expect(held.start).toHaveBeenCalledOnce();
      expect(listPluginServiceHealthFailures(registry)).not.toEqual([]);
    } else {
      const latest = recovery === "retry" ? configFor("https://retry.example") : undefined;
      const retrying = latest ? candidate.current.reload(latest, new Set([held.id])) : undefined;
      release.resolve();
      await retrying;
      if (recovery === "deferred-handoff") {
        await vi.advanceTimersByTimeAsync(0);
        expect(held.start).toHaveBeenCalledOnce();
        expect(watching).toBe(false);
        await candidate.start({
          config: successorConfig,
        });
      }
      await restarted.promise;
      await vi.advanceTimersByTimeAsync(0);
      expectCalls(held, 2, 1);
      expect(watching).toBe(true);
      expect(contexts[1]!.config).toBe(latest ?? (handoff ? successorConfig : next));
      expect(sibling.start).toHaveBeenCalledTimes(2);
      expect(listPluginServiceHealthFailures(registry)).toEqual([]);
      expect(() => emit(contexts[1], "restarted")).not.toThrow();
    }
    await candidate.current.stop();
  });

  it("rejects a queued reload when a selective stop has already claimed its service", async () => {
    const { entered, release, run: stop } = heldOperation();
    const exporter = service("exporter", { stop });
    const sibling = service("sibling");
    const registry = ownedServices(exporter, { id: sibling.id, start: sibling.start });
    const broadcastPluginEvent = vi.fn();
    const handle = await starter({ registry, broadcastPluginEvent }).start();
    const reloading = track(handle.reload({}, new Set(["exporter"]))).catch(
      (error: unknown) => error,
    );
    const stopping = track(stopSelected(handle, "exporter"));
    await entered.promise;
    release.resolve();
    await stopping;
    expect(await reloading).toMatchObject({ message: expect.stringContaining("stopping") });
    expect(exporter.start).toHaveBeenCalledOnce();
    emit(sibling.contexts[0], "alive");
    expect(() => emit(exporter.contexts[0], "stale")).toThrow("no longer active");
    expect(broadcastPluginEvent).toHaveBeenCalledOnce();
  });

  it.each([false, true])("owns late startup cleanup (managed=%s)", async (managed) => {
    vi.useFakeTimers();
    const resource = lateResource(`plugin-${managed ? "managed" : "candidate"}-late-start`);
    const { entered, release, stop } = resource;
    const registry = createEmptyPluginRegistry();
    const record = createPluginRecord({ id: "candidate" });
    if (managed) {
      registry.plugins.push(record);
    }
    const instance = managed ? new PluginInstance(record.id, { record, registry }) : undefined;
    const dispatch = vi.fn();
    const invoke = instance?.wrap(dispatch);
    let lateFailure: unknown;
    const contexts: OpenClawPluginServiceContext[] = [];
    const definition: OpenClawPluginService = {
      id: managed ? "late-start" : "held",
      async start(context) {
        contexts.push(context);
        if (!managed) {
          registerPluginHttpRoute({ path: "/traced-service", auth: "plugin", handler: vi.fn() });
        }
        await resource.wait();
        try {
          invoke?.();
        } catch (error) {
          lateFailure = error;
        }
        resource.attach();
      },
      stop,
    };
    const queuedStart = vi.fn();
    registry.services.push(
      ...registryFor(
        "candidate",
        instance?.wrap(definition) ?? definition,
        ...(!managed ? [{ id: "queued", start: queuedStart }] : []),
      ).services,
    );
    const broadcastPluginEvent = vi.fn();
    const candidate = starter({
      registry,
      ...(!managed
        ? {
            startupTrace: createGatewayStartupTrace(createSubsystemLogger("test/service-startup")),
            broadcastPluginEvent,
          }
        : {}),
      throwOnStartError: true,
    });
    const operation = candidate.start().catch((error: unknown) => error);
    await entered.promise;
    await vi.advanceTimersByTimeAsync(PLUGIN_SERVICE_REPLACEMENT_STOP_TIMEOUT_MS);
    if (instance) {
      expect(await operation).toBeInstanceOf(AggregateError);
      const retirement = track(instance.dispose());
      await vi.advanceTimersByTimeAsync(PLUGIN_SERVICE_REPLACEMENT_STOP_TIMEOUT_MS);
      expect(() => instance.run(() => "retired dispatch")).toThrow("reloaded or disabled");
      release.resolve();
      await stopHandles();
      expect(dispatch).not.toHaveBeenCalled();
      expect(lateFailure).toMatchObject({
        message: expect.stringContaining("reloaded or disabled"),
      });
      expect(stop).toHaveBeenCalledOnce();
      resource.expectClean();
      await retirement;
      expect(instance.lifecycle.signal.aborted).toBe(true);
      return;
    }
    expect(await operation).toMatchObject({
      errors: [
        expect.objectContaining({
          message: expect.stringContaining("plugin service startup timed out"),
        }),
      ],
    });
    expect(stop).not.toHaveBeenCalled();
    expect(queuedStart).not.toHaveBeenCalled();
    expect(registry.httpRoutes).toEqual([]);
    expect(() => emit(contexts[0], "late")).toThrow("no longer active");
    await expect(candidate.start()).rejects.toThrow("cleanup remains pending");
    expect(contexts).toHaveLength(1);
    let stopped = false;
    const stopping = track(candidate.current.stop()).then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);
    release.resolve();
    await stopping;
    expect(stop).toHaveBeenCalledOnce();
    resource.expectClean();
    expect(queuedStart).not.toHaveBeenCalled();
    await candidate.start();
    expect(contexts).toHaveLength(2);
    expect(queuedStart).toHaveBeenCalledOnce();
    emit(contexts[1], "ready");
    expect(broadcastPluginEvent).toHaveBeenCalledOnce();
    await candidate.current.stop();
    expect(stop).toHaveBeenCalledTimes(2);
    resource.expectClean();
  });

  it.each([false, true])(
    "transfers an admitted reload restart with its handle (successor stopped=%s)",
    async (stopSuccessor) => {
      const { entered, release, run: stop } = heldOperation();
      const reloaded = service("reloading", { stop });
      const { contexts } = reloaded;
      const sibling = service("sibling");
      const registry = createRegistry([reloaded, sibling]);
      const successorConfig: OpenClawConfig = {};
      const candidate = starter({ registry, getCronService: () => undefined });
      const previous = await candidate.start();
      const reloading = track(previous.reload({}, new Set([reloaded.id])));
      let stopping: ReturnType<PluginServicesHandle["stop"]> | undefined;
      await entered.promise;
      const nextRegistry = createEmptyPluginRegistry();
      nextRegistry.services.push(...registry.services);
      const starting = candidate.start({
        registry: nextRegistry,
        config: successorConfig,
      });
      if (stopSuccessor) {
        stopping = track(candidate.current.stop());
      }
      expect(reloaded.start).toHaveBeenCalledOnce();
      release.resolve();
      await Promise.all([reloading, starting, stopping]);
      expectCalls(reloaded, stopSuccessor ? 1 : 2, 1);
      expect(() => contexts[0]!.getCron?.()).toThrow("no longer active");
      expectCalls(sibling, 1, stopSuccessor ? 1 : 0);
      await previous.stop();
      if (!stopSuccessor) {
        expect(contexts[1]!.config).toBe(successorConfig);
        expect(() => contexts[1]!.getCron?.()).not.toThrow();
      }
      await candidate.current.stop();
      await previous.stop();
      expect(reloaded.stop).toHaveBeenCalledTimes(stopSuccessor ? 1 : 2);
    },
  );
});

describe("plugin service transfer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDiagnosticEventsForTest();
    resetDiagnosticTracePropagationForTest();
    resetDiagnosticStabilityRecorderForTest();
    resetPluginRuntimeStateForTest();
  });

  it.each([
    { phase: "starting", rejects: false },
    { phase: "ready", rejects: true },
  ] as const)(
    "owns a selective stop across $phase handoff (rejects: $rejects)",
    async ({ phase, rejects }) => {
      const entered = deferred();
      const release = deferred();
      const failure = new Error("selected cleanup rejected");
      const selected = service("selected", {
        stop() {
          if (rejects) {
            throw failure;
          }
        },
        start() {
          if (phase === "starting" && selected.contexts.length === 1) {
            entered.resolve();
            return release.promise;
          }
          return undefined;
        },
      });
      const sibling = service("sibling");
      const registry = ownedServices(selected, sibling);
      const candidate = starter({ registry, getCronService: () => undefined });
      const starting = candidate.start();
      const previous = candidate.current;
      await (phase === "starting" ? entered.promise : starting);
      const oldContext = selected.contexts[0]!;
      const stopOutcome = track(stopSelected(previous, "selected")).catch(
        (error: unknown) => error,
      );
      expect(() => oldContext.getCron?.()).toThrow("stopping");
      const successor = await candidate.start();
      release.resolve();
      await starting;
      const outcome = await stopOutcome;
      expect(selected.stop).toHaveBeenCalledOnce();
      expect(() => oldContext.getCron?.()).toThrow("no longer active");
      expect(sibling.stop).not.toHaveBeenCalled();
      expect([selected.contexts.length, sibling.contexts.length]).toEqual([1, 1]);
      if (rejects) {
        expect(outcome).toBeInstanceOf(AggregateError);
        await expect(stopSelected(successor, "selected")).rejects.toThrow(
          "plugin service replacement cleanup failed",
        );
        expect(selected.stop).toHaveBeenCalledOnce();
      } else {
        expect(outcome).toBeUndefined();
        await candidate.start();
        expect([selected.contexts.length, sibling.contexts.length]).toEqual([2, 1]);
      }
      await stopHandles();
    },
  );

  it("keeps unchanged services with the issued handle when a candidate cannot start", async () => {
    const sibling = service("sibling");
    const oldRegistry = registryFor("sibling", sibling);
    const previous = await starter({ registry: oldRegistry }).start();
    const broken = service("broken", {
      start() {
        throw new Error("candidate failed");
      },
    });
    const nextRegistry = registryFor("broken", broken);
    nextRegistry.services.push(...oldRegistry.services);
    const candidate = starter({ registry: nextRegistry, previous, throwOnStartError: true });
    await expect(candidate.start()).rejects.toThrow("plugin services failed to start");
    expect(candidate.current).toBeDefined();
    expect(broken.stop).toHaveBeenCalledOnce();
    expectCalls(sibling, 1, 0);
    await previous.stop();
    expect(sibling.stop).not.toHaveBeenCalled();
    await candidate.current?.stop();
    expect(sibling.stop).toHaveBeenCalledOnce();
  });

  it("transfers an unchanged service without restarting it and stops only the replaced owner", async () => {
    let dependencyReady = false;
    const startDependency = () => {
      dependencyReady = true;
    };
    const stopDependency = () => {
      dependencyReady = false;
    };
    const first = service("first", { start: startDependency, stop: stopDependency });
    const sibling = service("sibling", {
      start() {
        if (!dependencyReady) {
          throw new Error("dependency must start before its consumer");
        }
      },
    });
    const replacement = service("first", { start: startDependency, stop: stopDependency });
    const oldRegistry = ownedServices(first, sibling);
    const siblingRegistration = oldRegistry.services[1]!;
    const previous = await starter({ registry: oldRegistry }).start();
    await stopSelected(previous, "first");
    const nextRegistry = registryFor("first", replacement);
    nextRegistry.services.push(siblingRegistration);
    const candidate = starter({ registry: nextRegistry, previous, throwOnStartError: true });
    const started = await candidate.start();
    expect(first.stop).toHaveBeenCalledOnce();
    expect(replacement.start).toHaveBeenCalledOnce();
    expectCalls(sibling, 1, 0);
    await started.reload({}, new Set(["first", "sibling"]));
    expect(replacement.start).toHaveBeenCalledTimes(2);
    expect(sibling.start).toHaveBeenCalledTimes(2);
    await candidate.current?.stop();
    await previous.stop();
    expect(sibling.stop).toHaveBeenCalledTimes(2);
    expect(replacement.stop).toHaveBeenCalledTimes(2);
  });
});
