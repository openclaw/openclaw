import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry, type PluginRegistry } from "./registry.js";
import type { OpenClawPluginServiceContext } from "./types.js";

const mockedLogger = vi.hoisted(() => ({
  info: vi.fn<(msg: string) => void>(),
  warn: vi.fn<(msg: string) => void>(),
  error: vi.fn<(msg: string) => void>(),
  debug: vi.fn<(msg: string) => void>(),
  child: vi.fn(() => mockedLogger),
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => mockedLogger,
}));

import {
  emitTrustedDiagnosticEvent,
  resetDiagnosticEventsForTest,
  waitForDiagnosticEventsDrained,
} from "../infra/diagnostic-events.js";
import { markHostPluginUsageDiagnosticEvent } from "../infra/diagnostic-plugin-usage-provenance.js";
import {
  formatPropagatedDiagnosticTraceparent,
  resetDiagnosticTracePropagationForTest,
} from "../infra/diagnostic-trace-propagation.js";
import {
  getDiagnosticStabilitySnapshot,
  resetDiagnosticStabilityRecorderForTest,
  type DiagnosticExporterHealthUpdate,
} from "../logging/diagnostic-stability.js";
import { createDeferredCore } from "../shared/deferred.js";
import { queuePluginSessionsChanged } from "./gateway-events.js";
import { registerPluginHttpRoute, withPluginHttpRouteRegistry } from "./http-registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "./runtime.js";
import { listPluginServiceHealthFailures } from "./service-health.js";
import { PLUGIN_SERVICE_REPLACEMENT_STOP_TIMEOUT_MS } from "./services.js";
import {
  createRegistry,
  createServiceRegistration,
  startPluginServices,
  type PluginServicesHandle,
} from "./services.test-support.js";

type TrustedExporterInternalDiagnostics = NonNullable<
  OpenClawPluginServiceContext["internalDiagnostics"]
> & {
  reportExporterHealth?: (update: DiagnosticExporterHealthUpdate) => void;
};

const readScope = { scope: "operator.read" } as const;
function expectInactive(run: () => unknown) {
  expect(run).toThrow("no longer active");
}

const handles = new Set<PluginServicesHandle>();
const pending = new Set<Promise<unknown>>();
const releases: Array<() => void> = [];
const cleanups: Array<() => void> = [];
afterEach(async () => {
  try {
    releases.splice(0).forEach((release) => release());
    await Promise.allSettled(pending);
    await Promise.all([...handles].map((handle) => handle.stop()));
  } finally {
    cleanups.splice(0).forEach((cleanup) => cleanup());
    pending.clear();
    handles.clear();
    vi.useRealTimers();
  }
});

function track<T>(promise: Promise<T>): Promise<T> {
  pending.add(promise);
  return promise;
}

function deferred() {
  const result = createDeferredCore();
  releases.push(() => result.resolve());
  return result;
}

function strictStop(
  handle: PluginServicesHandle,
  budget = PLUGIN_SERVICE_REPLACEMENT_STOP_TIMEOUT_MS,
) {
  return track(handle.stop({ strict: true, deadlineAtMs: Date.now() + budget }));
}

function start(
  registry: PluginRegistry,
  options: Pick<
    Parameters<typeof startPluginServices>[0],
    "startupTrace" | "broadcastPluginEvent"
  > = {},
) {
  return track(
    startPluginServices({
      registry,
      config: {},
      ...options,
      onHandle: (handle) => handles.add(handle),
    }),
  );
}

function unreadableError(message: string) {
  return Object.defineProperty(new Error(message), "message", {
    get() {
      throw new Error("message getter failed");
    },
  });
}

type Service = Parameters<typeof createRegistry>[0][number];

function service(id: string, onStart: Service["start"] = () => {}, stop?: Service["stop"]) {
  const entry: Service & { context?: OpenClawPluginServiceContext } = {
    id,
    start(ctx) {
      entry.context = ctx;
      return onStart(ctx);
    },
    stop,
  };
  return entry;
}

function startSingleService(entry: Service, options: Parameters<typeof start>[1] = {}) {
  return start(createRegistry([entry]), options);
}

function addExporter(registry: PluginRegistry, entry: Service) {
  registry.services.push(
    createServiceRegistration(entry, {
      pluginId: entry.id,
      origin: "bundled",
      rootDir: "/plugins/test-plugin",
    }),
  );
}

function startBundledExporter(entry: Service) {
  const registry = createEmptyPluginRegistry();
  addExporter(registry, entry);
  return start(registry);
}

describe("startPluginServices", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDiagnosticEventsForTest();
    resetDiagnosticTracePropagationForTest();
    resetDiagnosticStabilityRecorderForTest();
    resetPluginRuntimeStateForTest();
  });

  it("fences service health reporters to their owning generation", async () => {
    const contexts: OpenClawPluginServiceContext[] = [];
    const registry = createRegistry([
      service("service", (ctx) => {
        contexts.push(ctx);
      }),
    ]);
    const generationA = await start(registry);
    await start(registry);
    contexts[0]?.serviceHealth?.reportFailure(new Error("stale failure"));
    expect(listPluginServiceHealthFailures(registry)).toEqual([]);
    contexts[1]?.serviceHealth?.reportFailure(new Error("current failure"));
    expect(listPluginServiceHealthFailures(registry)).toMatchObject([
      { serviceId: "service", error: "current failure" },
    ]);
    await generationA.stop();
    expect(listPluginServiceHealthFailures(registry)).toHaveLength(1);
    contexts[1]?.serviceHealth?.clearFailure();
    expect(listPluginServiceHealthFailures(registry)).toEqual([]);
  });

  it.each([false, true])(
    "drains producers before exporters and retains failures (strict=%s)",
    async (strict) => {
      const order: string[] = [];
      const producerError = unreadableError("producer stop failed");
      const exporterError = new Error("exporter stop failed");
      const registry = createRegistry([
        service("producer", undefined, () => {
          order.push("producer");
          emitTrustedDiagnosticEvent({
            type: "log.record",
            level: "INFO",
            message: "queued during shutdown",
          });
          throw producerError;
        }),
        service("sibling", undefined, () => {
          order.push("sibling");
        }),
      ]);
      for (const id of ["diagnostics-prometheus", "diagnostics-otel"]) {
        addExporter(registry, {
          id,
          start(ctx) {
            if (id === "diagnostics-otel") {
              ctx.internalDiagnostics!.onEvent((event) => {
                if (event.type === "log.record") {
                  order.push("event");
                }
              });
            }
          },
          stop() {
            order.push(id);
            if (id === "diagnostics-otel") {
              throw exporterError;
            }
          },
        });
      }
      const handle = await start(registry);
      if (strict) {
        await expect(strictStop(handle)).rejects.toMatchObject({
          errors: [
            {
              cause: producerError,
              message: expect.stringContaining("plugin=plugin:test, service=producer"),
            },
            {
              cause: exporterError,
              message: expect.stringContaining("plugin=diagnostics-otel, service=diagnostics-otel"),
            },
          ],
        });
      } else {
        await expect(handle.stop()).resolves.toEqual({ errors: [producerError, exporterError] });
      }
      await waitForDiagnosticEventsDrained();
      expect(order).toEqual([
        "sibling",
        "producer",
        "event",
        "diagnostics-otel",
        "diagnostics-prometheus",
      ]);
      await handle.stop();
      expect(order).toHaveLength(5);
    },
  );

  it("rolls back partially started services even when their error message is inaccessible", async () => {
    const acquired = new Set<string>();
    const received = vi.fn();
    const siblingStart = vi.fn(() => {
      expect(acquired.size).toBe(0);
    });
    const rollback = vi.fn((ctx: OpenClawPluginServiceContext) => {
      acquired.delete("failed");
      ctx.gatewayEvents?.emit("rolled-back", {}, readScope);
    });
    const broadcastPluginEvent = vi.fn();
    const failed = service(
      "failed",
      (ctx) => {
        acquired.add("failed");
        ctx.gatewayEvents?.onSessionsChanged(received);
        throw unreadableError("startup failed");
      },
      rollback,
    );
    const handle = await start(createRegistry([failed, service("sibling", siblingStart)]), {
      broadcastPluginEvent,
    });
    expect(rollback).toHaveBeenCalledOnce();
    expect(acquired.size).toBe(0);
    expect(siblingStart).toHaveBeenCalledOnce();
    expect(broadcastPluginEvent).toHaveBeenCalledExactlyOnceWith(
      "plugin.plugin:test.rolled-back",
      {},
      "operator.read",
    );
    expectInactive(() => failed.context?.gatewayEvents?.emit("late", {}, readScope));
    queuePluginSessionsChanged({ sessionKey: "agent:main:main" });
    await Promise.resolve();
    expect(received).not.toHaveBeenCalled();
    await handle.stop();
    expect(rollback).toHaveBeenCalledOnce();
  });

  it("logs throwing and rejecting sessions.changed handlers without blocking siblings", async () => {
    const received = vi.fn();
    const rejectingHandler = (() =>
      Promise.reject(new Error("async handler failed"))) as () => void;
    await startSingleService(
      service("events", (ctx) => {
        ctx.gatewayEvents?.onSessionsChanged(() => {
          throw new Error("handler failed");
        });
        ctx.gatewayEvents?.onSessionsChanged(rejectingHandler);
        ctx.gatewayEvents?.onSessionsChanged(received);
      }),
      { broadcastPluginEvent: vi.fn() },
    );
    queuePluginSessionsChanged({ sessionKey: "agent:main:main", phase: "message" });
    await Promise.resolve();
    await Promise.resolve();
    expect(received).toHaveBeenCalledOnce();
    expect(mockedLogger.warn).toHaveBeenCalledWith(
      "plugin sessions.changed handler failed: Error: handler failed",
    );
    expect(mockedLogger.warn).toHaveBeenCalledWith(
      "plugin sessions.changed handler failed: Error: async handler failed",
    );
  });

  it("rejects unsafe event names, scopes, and payloads", async () => {
    const broadcastPluginEvent = vi.fn();
    const events = service("events");
    await startSingleService(events, { broadcastPluginEvent });
    const emit = events.context?.gatewayEvents?.emit as unknown as (
      event: string,
      payload: unknown,
      opts: { scope: string },
    ) => void;
    expect(() => emit("other.changed", {}, readScope)).toThrow("invalid plugin gateway event name");
    expect(() => emit("changed", { value: Number.NaN }, readScope)).toThrow("bounded JSON");
    expect(() => emit("changed", {}, { scope: "operator.approvals" })).toThrow("operator scope");
    expect(broadcastPluginEvent).not.toHaveBeenCalled();
  });

  it("registers dynamic HTTP routes into the service registry scope", async () => {
    const registry = createRegistry([
      service("route-service", () => {
        registerPluginHttpRoute({ path: "/service-route", auth: "plugin", handler: vi.fn() });
      }),
    ]);
    const pinnedRegistry = createEmptyPluginRegistry();
    setActivePluginRegistry(pinnedRegistry);
    await start(registry);
    expect(registry.httpRoutes.map((route) => route.path)).toEqual(["/service-route"]);
    expect(pinnedRegistry.httpRoutes).toHaveLength(0);
  });

  it("retains trusted exporter startup health after host rollback", async () => {
    const rollback = vi.fn();
    const handle = await startBundledExporter(
      service(
        "diagnostics-otel",
        (ctx) => {
          const diagnostics = ctx.internalDiagnostics as TrustedExporterInternalDiagnostics;
          diagnostics.reportExporterHealth?.({
            signal: "traces",
            transport: "otlp-http-protobuf",
            endpointMode: "configured",
            status: "failure",
            reason: "start_failed",
            errorCategory: "TypeError",
          });
          throw new TypeError("SDK startup failed");
        },
        rollback,
      ),
    );
    expect(rollback).toHaveBeenCalledOnce();
    await handle.stop();
    expect(rollback).toHaveBeenCalledOnce();
    expect(
      getDiagnosticStabilitySnapshot({ type: "telemetry.exporter", limit: 1000 }).events,
    ).toEqual([
      expect.objectContaining({
        source: "diagnostics-otel",
        target: "traces",
        transport: "otlp-http-protobuf",
        outcome: "failure",
        reason: "start_failed",
        errorCategory: "TypeError",
      }),
    ]);
  });

  it("passes a scoped startup trace through service context for owned subspans", async () => {
    const measured: string[] = [];
    const detail = vi.fn();
    const trace = "sidecars.plugin-services.plugin~003Atest.service-a";
    await startSingleService(
      service("service-a", async (ctx) => {
        ctx.startupTrace?.detail?.("probe.result", [["healthyCount", 1]]);
        await ctx.startupTrace?.measure("config:resolve", async () => {});
      }),
      {
        startupTrace: {
          detail,
          measure: async (name, run) => {
            measured.push(name);
            return await run();
          },
        },
      },
    );
    expect(measured).toEqual([trace, `${trace}.config~003Aresolve`]);
    expect(detail.mock.calls).toEqual([
      [`${trace}.probe.result`, [["healthyCount", 1]]],
      [
        "sidecars.plugin-services.summary",
        Object.entries({ serviceCount: 1, startedCount: 1, failedCount: 0 }),
      ],
    ]);
  });

  it.each([
    ["diagnostics-otel", "config", true, "diagnostics-otel", true],
    ["diagnostics-otel", "workspace", false, "diagnostics-otel", false],
    ["diagnostics-prometheus", "global", true, "not-diagnostics-prometheus", false],
  ] as const)(
    "gates %s diagnostics for %s installs (trusted=%s, plugin=%s)",
    async (serviceId, origin, trusted, pluginId, allowed) => {
      const entry = service(serviceId);
      const registry = createRegistry([entry], pluginId, origin);
      registry.services[0]!.trustedOfficialInstall = trusted;
      await start(registry);
      expect(entry.context?.internalDiagnostics !== undefined).toBe(allowed);
    },
  );

  it("delivers host plugin attribution only to the trusted OTel listener lane", async () => {
    const observed: Array<{ exporter: string; hostPluginId?: unknown }> = [];
    const registry = createEmptyPluginRegistry();
    for (const id of ["diagnostics-otel", "diagnostics-prometheus"]) {
      addExporter(registry, {
        id,
        start(ctx) {
          ctx.internalDiagnostics?.onEvent((event, _metadata, privateData) => {
            if (event.type === "model.usage") {
              observed.push({
                exporter: id,
                hostPluginId: (privateData as { hostPluginId?: unknown }).hostPluginId,
              });
            }
          });
        },
      });
    }
    await start(registry);
    emitTrustedDiagnosticEvent(
      markHostPluginUsageDiagnosticEvent({ type: "model.usage", usage: { input: 1 } }, "llm-task"),
    );
    expect(observed).toEqual([
      { exporter: "diagnostics-otel", hostPluginId: "llm-task" },
      { exporter: "diagnostics-prometheus", hostPluginId: undefined },
    ]);
  });

  it.each(["initial", "reload"] as const)(
    "retries a failed %s start in dependency order",
    async (phase) => {
      const failAt = phase === "initial" ? 1 : 2;
      let attempts = 0;
      let ready = false;
      const order: string[] = [];
      const failure = new Error("transient service start failure");
      const startService = vi.fn(() => {
        order.push("dependency");
        if (++attempts === failAt) {
          throw failure;
        }
        ready = true;
      });
      const siblingStart = vi.fn(() => {
        order.push("dependent");
        if (!ready) {
          throw new Error("dependency service is not running");
        }
      });
      const registry = createRegistry([
        service("retry-service", startService, () => {
          ready = false;
        }),
        service("sibling", siblingStart, () => {}),
      ]);
      const serviceIds = new Set(["retry-service", "sibling"]);
      const handle = await start(registry);
      if (phase === "reload") {
        await expect(handle.reload({}, serviceIds)).resolves.toBeUndefined();
      }
      expect(listPluginServiceHealthFailures(registry)).toContainEqual(
        expect.objectContaining({ serviceId: "retry-service", error: failure.message }),
      );
      await handle.reload({}, serviceIds);
      expect(order.slice(-2)).toEqual(["dependency", "dependent"]);
      expect(startService).toHaveBeenCalledTimes(failAt + 1);
      expect(siblingStart).toHaveBeenCalledTimes(phase === "reload" ? 3 : 2);
      expect(listPluginServiceHealthFailures(registry)).toEqual([]);
      await handle.stop();
    },
  );

  it("joins late reload resources before stopping the exporter after a strict timeout", async () => {
    vi.useFakeTimers();
    const entered = deferred();
    const release = deferred();
    const event = "service-late-start-reload";
    const listener = () => {};
    cleanups.push(() => process.off(event, listener));
    const listenerCount = process.listenerCount(event);
    const order: string[] = [];
    const stop = vi.fn(() => {
      order.push("producer-stop");
      process.off(event, listener);
    });
    const exporterStop = vi.fn(() => {
      order.push("exporter-stop");
    });
    let attempts = 0;
    const registry = createRegistry([
      service(
        "late-resource",
        async () => {
          if (++attempts === 2) {
            entered.resolve();
            await release.promise;
          }
          process.on(event, listener);
        },
        stop,
      ),
    ]);
    registry.services.unshift(
      createServiceRegistration(
        { id: "diagnostics-otel", start() {}, stop: exporterStop },
        { pluginId: "diagnostics-otel", origin: "bundled", rootDir: "/plugins/test-plugin" },
      ),
    );
    const handle = await start(registry);
    const reloading = track(handle.reload({}, new Set(["late-resource"])));
    await entered.promise;
    const stopping = strictStop(handle, 100).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(100);
    expect(await stopping).toBeInstanceOf(AggregateError);
    expect(stop).toHaveBeenCalledOnce();
    expect(exporterStop).not.toHaveBeenCalled();
    release.resolve();
    await reloading;
    await handle.stop();
    expect(process.listenerCount(event)).toBe(listenerCount);
    expect(stop).toHaveBeenCalledTimes(2);
    expect(exporterStop).toHaveBeenCalledOnce();
    expect(order.slice(-2)).toEqual(["producer-stop", "exporter-stop"]);
  });

  it("bounds strict cleanup and fences timed-out service routes, events, and health", async () => {
    vi.useFakeTimers();
    const cleanupDeferred = deferred();
    const received = vi.fn();
    const siblingStop = vi.fn();
    const broadcastPluginEvent = vi.fn();
    const lateFailures: unknown[] = [];
    const nestedRegistry = createEmptyPluginRegistry();
    const addRoute = (path: string) =>
      registerPluginHttpRoute({ path, auth: "plugin", handler: vi.fn(), throwOnFailure: true });
    const blocked = service(
      "blocked-cleanup",
      (ctx) => {
        ctx.gatewayEvents?.onSessionsChanged(received);
        addRoute("/owned-route");
      },
      async (ctx) => {
        await cleanupDeferred.promise;
        ctx.serviceHealth?.reportFailure(new Error("late stale failure"));
        for (const run of [
          () => ctx.gatewayEvents?.emit("late", {}, readScope),
          () => addRoute("/late-anonymous-route"),
          () => withPluginHttpRouteRegistry(nestedRegistry, () => addRoute("/late-nested-route")),
          () =>
            withPluginHttpRouteRegistry(
              nestedRegistry,
              () => addRoute("/late-replacement-lease-route"),
              { isActive: () => true, retain: (cleanup) => cleanup },
            ),
        ]) {
          try {
            run();
          } catch (error) {
            lateFailures.push(error);
          }
        }
      },
    );
    const registry = createRegistry([service("sibling", undefined, siblingStop), blocked]);
    const handle = await start(registry, { broadcastPluginEvent });
    const stopping = strictStop(handle).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(5_000);
    const failure = await stopping;
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([
      expect.objectContaining({
        message: expect.stringMatching(/plugin=plugin:test, service=blocked-cleanup.*timed out/),
      }),
    ]);
    expect(siblingStop).toHaveBeenCalledOnce();
    expect(registry.httpRoutes).toEqual([]);
    expectInactive(() => blocked.context?.gatewayEvents?.onSessionsChanged(received));
    const health = listPluginServiceHealthFailures(registry);
    expect(health).toEqual([
      expect.objectContaining({
        pluginId: "plugin:test",
        serviceId: "blocked-cleanup",
        error: expect.stringContaining("stop timed out"),
      }),
    ]);

    cleanupDeferred.resolve();
    await handle.stop();
    queuePluginSessionsChanged({ sessionKey: "agent:main:main" });
    await Promise.resolve();

    expect(lateFailures).toHaveLength(4);
    expect(received).not.toHaveBeenCalled();
    expect(broadcastPluginEvent).not.toHaveBeenCalled();
    expect(listPluginServiceHealthFailures(registry)).toEqual(health);
    expect(registry.httpRoutes).toEqual([]);
    expect(nestedRegistry.httpRoutes).toEqual([]);
  });

  it("bounds failed-start cleanup and retains it for final shutdown", async () => {
    vi.useFakeTimers();
    const cleanup = deferred();
    const stop = vi.fn(() => cleanup.promise);
    const broadcastPluginEvent = vi.fn();
    const siblingStart = vi.fn();
    const failed = service(
      "failed-start-hung-stop",
      () => {
        throw new Error("startup rejected");
      },
      stop,
    );
    const registry = createRegistry([failed, service("sibling", siblingStart)]);
    const settled = vi.fn((handle: PluginServicesHandle) => handle);
    const starting = start(registry, { broadcastPluginEvent }).then(settled);
    await vi.advanceTimersByTimeAsync(PLUGIN_SERVICE_REPLACEMENT_STOP_TIMEOUT_MS);

    expect(settled).toHaveBeenCalledOnce();
    const handle = await starting;
    expect(siblingStart).toHaveBeenCalledOnce();
    expectInactive(() => failed.context?.gatewayEvents?.emit("late", {}, readScope));
    expect(broadcastPluginEvent).not.toHaveBeenCalled();
    const cleanupSettled = vi.fn();
    const stopping = track(handle.stop().then(cleanupSettled));
    await vi.advanceTimersByTimeAsync(0);
    expect(cleanupSettled).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledOnce();
    cleanup.resolve();
    await stopping;
  });

  it("does not repeat rejected cleanup when startup fails after replacement settles", async () => {
    vi.useFakeTimers();
    const startup = deferred();
    const cleanupError = new Error("cleanup rejected");
    const order: string[] = [];
    const stop = vi.fn(() => {
      order.push("stop");
      return Promise.reject(cleanupError);
    });
    let handle!: PluginServicesHandle;
    const starting = track(
      startPluginServices({
        registry: createRegistry([
          service(
            "interrupted-startup",
            () => {
              order.push("start");
              return startup.promise;
            },
            stop,
          ),
        ]),
        config: {},
        onHandle: (issued) => {
          handle = issued;
          handles.add(issued);
        },
      }),
    );
    const stopped = strictStop(handle).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(PLUGIN_SERVICE_REPLACEMENT_STOP_TIMEOUT_MS);
    expect(await stopped).toMatchObject({
      errors: [{ message: expect.stringContaining("plugin service startup settlement timed out") }],
    });
    order.push("replacement-settled");
    expect(stop).not.toHaveBeenCalled();
    startup.reject(new Error("startup failed after replacement"));
    await starting;
    expect(order).toEqual(["start", "replacement-settled", "stop"]);
    await expect(strictStop(handle)).rejects.toMatchObject({ errors: [{ cause: cleanupError }] });
    mockedLogger.warn.mockClear();
    await expect(handle.stop()).resolves.toEqual({ errors: [cleanupError] });
    expect(mockedLogger.warn).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("revokes trusted diagnostics listeners, emitters, bridges, and health on stop", async () => {
    const listener = vi.fn();
    const lateListener = vi.fn();
    const traceContext = {
      traceId: "1234567890abcdef1234567890abcdef",
      spanId: "1234567890abcdef",
    };
    let diagnostics: TrustedExporterInternalDiagnostics | undefined;
    const handle = await startBundledExporter(
      service("diagnostics-otel", (ctx) => {
        diagnostics = ctx.internalDiagnostics as TrustedExporterInternalDiagnostics;
        diagnostics.onEvent(listener);
        diagnostics.registerTracePropagationBridge?.({ resolveTraceContext: () => undefined });
      }),
    );
    expect(formatPropagatedDiagnosticTraceparent(traceContext)).toBeUndefined();
    await handle.stop();
    expectInactive(() => diagnostics?.emit({ type: "log.record", level: "INFO", message: "late" }));
    expectInactive(() => diagnostics?.onEvent(lateListener));
    expectInactive(() =>
      diagnostics?.registerTracePropagationBridge?.({ resolveTraceContext: () => undefined }),
    );
    diagnostics?.reportExporterHealth?.({
      signal: "traces",
      transport: "otlp-http-protobuf",
      status: "failure",
      reason: "export_failed",
    });
    emitTrustedDiagnosticEvent({ type: "log.record", level: "INFO", message: "still active" });
    expect(listener).not.toHaveBeenCalled();
    expect(lateListener).not.toHaveBeenCalled();
    expect(formatPropagatedDiagnosticTraceparent(traceContext)).toBe(
      "00-1234567890abcdef1234567890abcdef-1234567890abcdef-01",
    );
    expect(
      getDiagnosticStabilitySnapshot({ type: "telemetry.exporter", limit: 1000 }).events,
    ).toEqual([]);
  });
});
