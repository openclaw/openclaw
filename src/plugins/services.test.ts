import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginOrigin } from "./plugin-origin.types.js";
import { createEmptyPluginRegistry, type PluginRegistry } from "./registry.js";
import { createRegistry } from "./services.test-support.js";
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
import {
  PLUGIN_SERVICE_REPLACEMENT_STOP_TIMEOUT_MS,
  startPluginServices,
  type PluginServicesHandle,
} from "./services.js";

type TrustedExporterInternalDiagnostics = NonNullable<
  OpenClawPluginServiceContext["internalDiagnostics"]
> & {
  reportExporterHealth?: (update: DiagnosticExporterHealthUpdate) => void;
};

const handles = new Set<PluginServicesHandle>();
afterEach(async () => {
  await Promise.all([...handles].map((handle) => handle.stop()));
  handles.clear();
});

function start(
  registry: PluginRegistry,
  options: Pick<
    Parameters<typeof startPluginServices>[0],
    "startupTrace" | "broadcastPluginEvent"
  > = {},
) {
  return startPluginServices({
    registry,
    config: {},
    ...options,
    onHandle: (handle) => handles.add(handle),
  });
}

function unreadableError(message: string) {
  return Object.defineProperty(new Error(message), "message", {
    get() {
      throw new Error("message getter failed");
    },
  });
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
      {
        id: "service",
        start: (ctx) => {
          contexts.push(ctx);
        },
      },
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
        {
          id: "producer",
          start() {},
          stop() {
            order.push("producer");
            emitTrustedDiagnosticEvent({
              type: "log.record",
              level: "INFO",
              message: "queued during shutdown",
            });
            throw producerError;
          },
        },
        {
          id: "sibling",
          start() {},
          stop() {
            order.push("sibling");
          },
        },
      ]);
      for (const id of ["diagnostics-prometheus", "diagnostics-otel"]) {
        registry.services.push(
          ...createRegistry(
            [
              {
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
              },
            ],
            id,
            "bundled",
          ).services,
        );
      }
      const handle = await start(registry);
      if (strict) {
        await expect(
          handle.stop({ strict: true, deadlineAtMs: Date.now() + 5_000 }),
        ).rejects.toMatchObject({
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
    let context: OpenClawPluginServiceContext | undefined;
    const rollback = vi.fn((ctx: OpenClawPluginServiceContext) => {
      acquired.delete("failed");
      ctx.gatewayEvents?.emit("rolled-back", {}, { scope: "operator.read" });
    });
    const broadcastPluginEvent = vi.fn();
    const handle = await start(
      createRegistry([
        {
          id: "failed",
          start(ctx) {
            context = ctx;
            acquired.add("failed");
            ctx.gatewayEvents?.onSessionsChanged(received);
            throw unreadableError("startup failed");
          },
          stop: rollback,
        },
        { id: "sibling", start: siblingStart },
      ]),
      { broadcastPluginEvent },
    );
    expect(rollback).toHaveBeenCalledOnce();
    expect(acquired.size).toBe(0);
    expect(siblingStart).toHaveBeenCalledOnce();
    expect(broadcastPluginEvent).toHaveBeenCalledExactlyOnceWith(
      "plugin.plugin:test.rolled-back",
      {},
      "operator.read",
    );
    expect(() => context?.gatewayEvents?.emit("late", {}, { scope: "operator.read" })).toThrow(
      "no longer active",
    );
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
    await start(
      createRegistry([
        {
          id: "events",
          start(ctx) {
            ctx.gatewayEvents?.onSessionsChanged(() => {
              throw new Error("handler failed");
            });
            ctx.gatewayEvents?.onSessionsChanged(rejectingHandler);
            ctx.gatewayEvents?.onSessionsChanged(received);
          },
        },
      ]),
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
    let context: OpenClawPluginServiceContext | undefined;
    const broadcastPluginEvent = vi.fn();
    await start(
      createRegistry([
        {
          id: "events",
          start: (ctx) => {
            context = ctx;
          },
        },
      ]),
      { broadcastPluginEvent },
    );
    const emit = context?.gatewayEvents?.emit as unknown as (
      event: string,
      payload: unknown,
      opts: { scope: string },
    ) => void;
    expect(() => emit("other.changed", {}, { scope: "operator.read" })).toThrow(
      "invalid plugin gateway event name",
    );
    expect(() => emit("changed", { value: Number.NaN }, { scope: "operator.read" })).toThrow(
      "bounded JSON",
    );
    expect(() => emit("changed", {}, { scope: "operator.approvals" })).toThrow("operator scope");
    expect(broadcastPluginEvent).not.toHaveBeenCalled();
  });

  it("registers dynamic HTTP routes into the service registry scope", async () => {
    const registry = createRegistry([
      {
        id: "route-service",
        start() {
          registerPluginHttpRoute({ path: "/service-route", auth: "plugin", handler: vi.fn() });
        },
      },
    ]);
    const pinnedRegistry = createEmptyPluginRegistry();
    setActivePluginRegistry(pinnedRegistry);
    await start(registry);
    expect(registry.httpRoutes.map((route) => route.path)).toEqual(["/service-route"]);
    expect(pinnedRegistry.httpRoutes).toHaveLength(0);
  });

  it("retains trusted exporter startup health after host rollback", async () => {
    const rollback = vi.fn();
    const handle = await start(
      createRegistry(
        [
          {
            id: "diagnostics-otel",
            start(ctx) {
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
            stop: rollback,
          },
        ],
        "diagnostics-otel",
        "bundled",
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
    await start(
      createRegistry([
        {
          id: "service-a",
          async start(ctx) {
            ctx.startupTrace?.detail?.("probe.result", [["healthyCount", 1]]);
            await ctx.startupTrace?.measure("config:resolve", async () => {});
          },
        },
      ]),
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
    expect(measured).toEqual([
      "sidecars.plugin-services.plugin~003Atest.service-a",
      "sidecars.plugin-services.plugin~003Atest.service-a.config~003Aresolve",
    ]);
    expect(detail.mock.calls).toEqual([
      ["sidecars.plugin-services.plugin~003Atest.service-a.probe.result", [["healthyCount", 1]]],
      [
        "sidecars.plugin-services.summary",
        [
          ["serviceCount", 1],
          ["startedCount", 1],
          ["failedCount", 0],
        ],
      ],
    ]);
  });

  it("grants internal diagnostics only to trusted diagnostics exporter services", async () => {
    const startExporter = async (
      serviceId: string,
      origin: PluginOrigin,
      trusted = false,
      pluginId = serviceId,
    ) => {
      let context: OpenClawPluginServiceContext | undefined;
      const registry = createRegistry(
        [
          {
            id: serviceId,
            start: (ctx) => {
              context = ctx;
            },
          },
        ],
        pluginId,
        origin,
      );
      registry.services[0]!.trustedOfficialInstall = trusted;
      await start(registry);
      return context?.internalDiagnostics;
    };
    expect(await startExporter("diagnostics-otel", "config", true)).toBeDefined();
    expect(await startExporter("diagnostics-otel", "workspace")).toBeUndefined();
    expect(
      await startExporter("diagnostics-prometheus", "global", true, "not-diagnostics-prometheus"),
    ).toBeUndefined();
  });

  it("delivers host plugin attribution only to the trusted OTel listener lane", async () => {
    const observed: Array<{ exporter: string; hostPluginId?: unknown }> = [];
    const registry = createEmptyPluginRegistry();
    for (const id of ["diagnostics-otel", "diagnostics-prometheus"]) {
      registry.services.push(
        ...createRegistry(
          [
            {
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
            },
          ],
          id,
          "bundled",
        ).services,
      );
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
        {
          id: "retry-service",
          start: startService,
          stop: () => {
            ready = false;
          },
        },
        { id: "sibling", start: siblingStart, stop() {} },
      ]);
      const serviceIds = new Set(["retry-service", "sibling"]);
      const handle = await start(registry);
      try {
        if (phase === "reload") {
          await expect(handle.reload({}, serviceIds)).rejects.toThrow(
            "plugin service reload startup failed",
          );
        }
        expect(listPluginServiceHealthFailures(registry)).toContainEqual(
          expect.objectContaining({ serviceId: "retry-service", error: failure.message }),
        );
        await handle.reload({}, serviceIds);
        expect(order.slice(-2)).toEqual(["dependency", "dependent"]);
        expect(startService).toHaveBeenCalledTimes(failAt + 1);
        expect(siblingStart).toHaveBeenCalledTimes(2);
        expect(listPluginServiceHealthFailures(registry)).toEqual([]);
      } finally {
        await handle.stop();
      }
    },
  );

  it("joins late reload resources before stopping the exporter after a strict timeout", async () => {
    vi.useFakeTimers();
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const event = "service-late-start-reload";
    const listener = () => {};
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
      {
        id: "late-resource",
        async start() {
          if (++attempts === 2) {
            entered.resolve();
            await release.promise;
          }
          process.on(event, listener);
        },
        stop,
      },
    ]);
    registry.services.unshift(
      ...createRegistry(
        [{ id: "diagnostics-otel", start() {}, stop: exporterStop }],
        "diagnostics-otel",
        "bundled",
      ).services,
    );
    const handle = await start(registry);
    const reloading = handle.reload({}, new Set(["late-resource"]));
    let stopping: Promise<unknown> | undefined;
    try {
      await entered.promise;
      stopping = handle
        .stop({ strict: true, deadlineAtMs: Date.now() + 100 })
        .catch((error: unknown) => error);
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
    } finally {
      release.resolve();
      await Promise.allSettled([reloading, stopping]);
      await handle.stop();
      process.off(event, listener);
      vi.useRealTimers();
    }
  });

  it("bounds strict cleanup and fences timed-out service routes, events, and health", async () => {
    vi.useFakeTimers();
    const cleanupDeferred = createDeferredCore();
    const received = vi.fn();
    const siblingStop = vi.fn();
    const broadcastPluginEvent = vi.fn();
    const lateFailures: unknown[] = [];
    const nestedRegistry = createEmptyPluginRegistry();
    const addRoute = (path: string) =>
      registerPluginHttpRoute({ path, auth: "plugin", handler: vi.fn(), throwOnFailure: true });
    let context: OpenClawPluginServiceContext | undefined;
    const registry = createRegistry([
      { id: "sibling", start: () => {}, stop: siblingStop },
      {
        id: "blocked-cleanup",
        start: (ctx) => {
          context = ctx;
          ctx.gatewayEvents?.onSessionsChanged(received);
          addRoute("/owned-route");
        },
        stop: async (ctx) => {
          await cleanupDeferred.promise;
          ctx.serviceHealth?.reportFailure(new Error("late stale failure"));
          for (const run of [
            () => ctx.gatewayEvents?.emit("late", {}, { scope: "operator.read" }),
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
      },
    ]);
    let stopping: ReturnType<PluginServicesHandle["stop"]> | undefined;

    try {
      const handle = await start(registry, { broadcastPluginEvent });
      let failure: unknown;
      stopping = handle
        .stop({ strict: true, deadlineAtMs: Date.now() + 5_000 })
        .catch((error: unknown) => {
          failure = error;
        });
      await vi.advanceTimersByTimeAsync(5_000);

      expect(failure).toBeInstanceOf(AggregateError);
      expect((failure as AggregateError).errors).toEqual([
        expect.objectContaining({
          message: expect.stringMatching(/plugin=plugin:test, service=blocked-cleanup.*timed out/),
        }),
      ]);
      expect(siblingStop).toHaveBeenCalledOnce();
      expect(registry.httpRoutes).toEqual([]);
      expect(() => context?.gatewayEvents?.onSessionsChanged(received)).toThrow("no longer active");
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
    } finally {
      cleanupDeferred.resolve();
      await stopping;
      vi.useRealTimers();
    }
  });

  it("bounds failed-start cleanup and retains it for final shutdown", async () => {
    vi.useFakeTimers();
    const cleanup = createDeferredCore();
    const stop = vi.fn(() => cleanup.promise);
    const broadcastPluginEvent = vi.fn();
    const siblingStart = vi.fn();
    let context: OpenClawPluginServiceContext | undefined;
    const registry = createRegistry([
      {
        id: "failed-start-hung-stop",
        start: (ctx) => {
          context = ctx;
          throw new Error("startup rejected");
        },
        stop,
      },
      { id: "sibling", start: siblingStart },
    ]);
    let starting: Promise<PluginServicesHandle> | undefined;
    let stopping: Promise<void> | undefined;
    let settled = false;

    try {
      starting = start(registry, { broadcastPluginEvent }).then((handle) => {
        settled = true;
        return handle;
      });
      await vi.advanceTimersByTimeAsync(PLUGIN_SERVICE_REPLACEMENT_STOP_TIMEOUT_MS);

      expect(settled).toBe(true);
      const handle = await starting;
      expect(siblingStart).toHaveBeenCalledOnce();
      expect(() => context?.gatewayEvents?.emit("late", {}, { scope: "operator.read" })).toThrow(
        "no longer active",
      );
      expect(broadcastPluginEvent).not.toHaveBeenCalled();
      let cleanupSettled = false;
      stopping = handle.stop().then(() => {
        cleanupSettled = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(cleanupSettled).toBe(false);
      expect(stop).toHaveBeenCalledOnce();
      cleanup.resolve();
      await stopping;
    } finally {
      cleanup.resolve();
      await Promise.allSettled([starting, stopping]);
      vi.useRealTimers();
    }
  });

  it("does not repeat rejected cleanup when startup fails after replacement settles", async () => {
    vi.useFakeTimers();
    const startup = createDeferredCore();
    const cleanupError = new Error("cleanup rejected");
    const order: string[] = [];
    const stop = vi.fn(() => {
      order.push("stop");
      return Promise.reject(cleanupError);
    });
    let handle!: PluginServicesHandle;
    const starting = startPluginServices({
      registry: createRegistry([
        {
          id: "interrupted-startup",
          start: () => {
            order.push("start");
            return startup.promise;
          },
          stop,
        },
      ]),
      config: {},
      onHandle: (issued) => {
        handle = issued;
      },
    });
    const stopped = handle
      .stop({
        strict: true,
        deadlineAtMs: Date.now() + PLUGIN_SERVICE_REPLACEMENT_STOP_TIMEOUT_MS,
      })
      .catch((error: unknown) => error);
    try {
      await vi.advanceTimersByTimeAsync(PLUGIN_SERVICE_REPLACEMENT_STOP_TIMEOUT_MS);
      expect(await stopped).toMatchObject({
        errors: [
          { message: expect.stringContaining("plugin service startup settlement timed out") },
        ],
      });
      order.push("replacement-settled");
      expect(stop).not.toHaveBeenCalled();
      startup.reject(new Error("startup failed after replacement"));
      await starting;
      expect(order).toEqual(["start", "replacement-settled", "stop"]);
      await expect(
        handle.stop({
          strict: true,
          deadlineAtMs: Date.now() + PLUGIN_SERVICE_REPLACEMENT_STOP_TIMEOUT_MS,
        }),
      ).rejects.toMatchObject({ errors: [{ cause: cleanupError }] });
      mockedLogger.warn.mockClear();
      await expect(handle.stop()).resolves.toEqual({ errors: [cleanupError] });
      expect(mockedLogger.warn).not.toHaveBeenCalled();
      expect(stop).toHaveBeenCalledOnce();
    } finally {
      startup.reject(new Error("startup test cleanup"));
      await starting;
      await stopped;
      vi.useRealTimers();
    }
  });

  it("revokes trusted diagnostics listeners, emitters, bridges, and health on stop", async () => {
    const listener = vi.fn();
    const lateListener = vi.fn();
    const traceContext = {
      traceId: "1234567890abcdef1234567890abcdef",
      spanId: "1234567890abcdef",
    };
    let diagnostics: TrustedExporterInternalDiagnostics | undefined;
    const handle = await start(
      createRegistry(
        [
          {
            id: "diagnostics-otel",
            start(ctx) {
              diagnostics = ctx.internalDiagnostics as TrustedExporterInternalDiagnostics;
              diagnostics.onEvent(listener);
              diagnostics.registerTracePropagationBridge?.({
                resolveTraceContext: () => undefined,
              });
            },
          },
        ],
        "diagnostics-otel",
        "bundled",
      ),
    );
    expect(formatPropagatedDiagnosticTraceparent(traceContext)).toBeUndefined();
    await handle.stop();
    expect(() => diagnostics?.emit({ type: "log.record", level: "INFO", message: "late" })).toThrow(
      "no longer active",
    );
    expect(() => diagnostics?.onEvent(lateListener)).toThrow("no longer active");
    expect(() =>
      diagnostics?.registerTracePropagationBridge?.({ resolveTraceContext: () => undefined }),
    ).toThrow("no longer active");
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
