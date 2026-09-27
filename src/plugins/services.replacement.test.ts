import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  emitTrustedDiagnosticEvent,
  resetDiagnosticEventsForTest,
} from "../infra/diagnostic-events.js";
import {
  formatPropagatedDiagnosticTraceparent,
  resetDiagnosticTracePropagationForTest,
} from "../infra/diagnostic-trace-propagation.js";
import { collectErrorGraphCandidates } from "../infra/errors.js";
import {
  getDiagnosticStabilitySnapshot,
  resetDiagnosticStabilityRecorderForTest,
  type DiagnosticExporterHealthUpdate,
} from "../logging/diagnostic-stability.js";
import { createDeferredCore } from "../shared/deferred.js";
import { queuePluginSessionsChanged } from "./gateway-events.js";
import { registerPluginHttpRoute, withPluginHttpRouteRegistry } from "./http-registry.js";
import { createEmptyPluginRegistry } from "./registry.js";
import { resetPluginRuntimeStateForTest } from "./runtime.js";
import { listPluginServiceHealthFailures } from "./service-health.js";
import {
  PLUGIN_SERVICE_REPLACEMENT_STOP_TIMEOUT_MS,
  startPluginServices,
  type PluginServicesHandle,
} from "./services.js";
import { createRegistry, createServiceConfig } from "./services.test-support.js";
import type { OpenClawPluginServiceContext } from "./types.js";

const mockedLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: vi.fn(() => mockedLogger),
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => mockedLogger,
}));

describe("plugin service replacement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDiagnosticEventsForTest();
    resetDiagnosticTracePropagationForTest();
    resetDiagnosticStabilityRecorderForTest();
    resetPluginRuntimeStateForTest();
  });

  it.each(["initial", "reload"] as const)(
    "finishes rollback when a failed %s start has an inaccessible error message",
    async (phase) => {
      const displayFailure = new Error("message getter failed");
      const failure = new Error("service startup failed");
      Object.defineProperty(failure, "message", {
        get() {
          throw displayFailure;
        },
      });
      const event = `service-message-start-${phase}`;
      const listener = () => {};
      const before = process.listenerCount(event);
      const failAt = phase === "initial" ? 1 : 2;
      let attempts = 0;
      const rollback = vi.fn(() => {
        process.off(event, listener);
      });
      const siblingStart = vi.fn(() => {
        expect(process.listenerCount(event)).toBe(before);
      });
      const registry = createRegistry([
        {
          id: "bad-message",
          start: () => {
            if (++attempts === failAt) {
              process.on(event, listener);
              throw failure;
            }
          },
          stop: rollback,
        },
        { id: "sibling", start: siblingStart },
      ]);
      const config = createServiceConfig();
      let handle: PluginServicesHandle | undefined;
      try {
        const startupFailure = await startPluginServices({
          registry,
          config,
          onHandle: (value) => {
            handle = value;
          },
        }).then(
          () => undefined,
          (error: unknown) => error,
        );
        expect.soft(startupFailure).toBeUndefined();
        if (!handle) {
          throw new Error("service handle was not issued");
        }
        if (phase === "reload") {
          const reloadFailure = await handle.reload(config, new Set(["bad-message"])).then(
            () => undefined,
            (error: unknown) => error,
          );
          const errors = collectErrorGraphCandidates(reloadFailure, (error) => [
            error.cause,
            ...(error instanceof AggregateError ? error.errors : []),
          ]);
          expect.soft(errors.includes(failure)).toBe(true);
          expect.soft(errors.includes(displayFailure)).toBe(false);
        }
        expect.soft(process.listenerCount(event)).toBe(before);
        expect.soft(rollback).toHaveBeenCalledTimes(failAt);
        expect(siblingStart).toHaveBeenCalledOnce();
        await handle.stop();
        expect(rollback).toHaveBeenCalledTimes(failAt);
      } finally {
        await handle?.stop();
        process.off(event, listener);
      }
    },
  );

  it.each(["ordinary", "strict"] as const)(
    "finishes sibling cleanup when a %s stop has an inaccessible error message",
    async (mode) => {
      const displayFailure = new Error("message getter failed");
      const failure = new Error("service cleanup failed");
      Object.defineProperty(failure, "message", {
        get() {
          throw displayFailure;
        },
      });
      const event = `service-message-stop-${mode}`;
      const listener = () => {};
      const before = process.listenerCount(event);
      const siblingStop = vi.fn(() => {
        process.off(event, listener);
      });
      const failedStop = vi.fn(() => {
        throw failure;
      });
      const handle = await startPluginServices({
        registry: createRegistry([
          {
            id: "sibling",
            start: () => {
              process.on(event, listener);
            },
            stop: siblingStop,
          },
          { id: "bad-message", start: () => {}, stop: failedStop },
        ]),
        config: createServiceConfig(),
      });
      const options =
        mode === "strict" ? { strict: true as const, deadlineAtMs: Date.now() + 5_000 } : undefined;
      try {
        const stopped = await handle.stop(options).then(
          () => undefined,
          (error: unknown) => error,
        );
        expect.soft(process.listenerCount(event)).toBe(before);
        expect.soft(siblingStop).toHaveBeenCalledOnce();
        expect(failedStop).toHaveBeenCalledOnce();
        if (mode === "ordinary") {
          expect(stopped).toBeUndefined();
        } else {
          const errors = collectErrorGraphCandidates(stopped, (error) => [
            error.cause,
            ...(error instanceof AggregateError ? error.errors : []),
          ]);
          expect(errors.includes(failure)).toBe(true);
          expect(errors.includes(displayFailure)).toBe(false);
        }
        await handle.stop();
        expect(siblingStop).toHaveBeenCalledOnce();
        expect(failedStop).toHaveBeenCalledOnce();
      } finally {
        await handle.stop().catch(() => {});
        process.off(event, listener);
      }
    },
  );

  it.each(["initial", "reload"] as const)("retries a failed %s service start", async (phase) => {
    let attempts = 0;
    let ready = false;
    const order: string[] = [];
    const failAt = phase === "initial" ? 1 : 2;
    const failure = new Error("transient service start failure");
    const start = vi.fn(() => {
      order.push("dependency");
      if (++attempts === failAt) {
        throw failure;
      }
      ready = true;
    });
    const stop = vi.fn(() => {
      ready = false;
    });
    const siblingStart = vi.fn(() => {
      order.push("dependent");
      if (!ready) {
        throw new Error("dependency service is not running");
      }
    });
    const registry = createRegistry([
      { id: "retry-service", start, stop },
      { id: "sibling", start: siblingStart, stop: () => {} },
    ]);
    const serviceIds = new Set(["retry-service", "sibling"]);
    const config = createServiceConfig();
    const handle = await startPluginServices({ registry, config });
    try {
      if (phase === "reload") {
        await expect(handle.reload(config, serviceIds)).rejects.toThrow();
      }
      expect(listPluginServiceHealthFailures(registry)).toContainEqual(
        expect.objectContaining({ serviceId: "retry-service", error: failure.message }),
      );
      await handle.reload(config, serviceIds);
      expect(order.slice(-2)).toEqual(["dependency", "dependent"]);
      expect(start).toHaveBeenCalledTimes(failAt + 1);
      expect(siblingStart).toHaveBeenCalledTimes(2);
      expect(listPluginServiceHealthFailures(registry)).toEqual([]);
    } finally {
      await handle.stop();
    }
  });

  it("keeps reload startup owned beyond the stop budget until its final cleanup", async () => {
    vi.useFakeTimers();
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const event = "service-reload-start-resource";
    const listener = () => {};
    const before = process.listenerCount(event);
    let starts = 0;
    const registry = createRegistry([
      {
        id: "delayed-reload",
        start: async () => {
          if (++starts === 2) {
            entered.resolve();
            await release.promise;
          }
          process.on(event, listener);
        },
        stop: () => {
          process.off(event, listener);
        },
      },
    ]);
    const config = createServiceConfig();
    const handle = await startPluginServices({ registry, config });
    let reloaded = false;
    const reloading = handle.reload(config, new Set(["delayed-reload"])).then(
      () => {
        reloaded = true;
      },
      (error: unknown) => {
        reloaded = true;
        return error;
      },
    );
    let stopping: Promise<void> | undefined;
    try {
      await entered.promise;
      await vi.advanceTimersByTimeAsync(PLUGIN_SERVICE_REPLACEMENT_STOP_TIMEOUT_MS);
      expect.soft(reloaded).toBe(false);
      let stopped = false;
      stopping = handle.stop().then(() => {
        stopped = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect.soft(stopped).toBe(false);
      release.resolve();
      await reloading;
      await stopping;
      expect(process.listenerCount(event)).toBe(before);
    } finally {
      release.resolve();
      await reloading;
      await stopping;
      await handle.stop();
      process.off(event, listener);
      vi.useRealTimers();
    }
  });

  it.each(["initial", "reload"] as const)(
    "cleans resources acquired after strict stop times out during %s startup",
    async (phase) => {
      vi.useFakeTimers();
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const event = `service-late-start-${phase}`;
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
      const blockedAttempt = phase === "initial" ? 1 : 2;
      const registry = createRegistry([
        {
          id: "late-resource",
          start: async () => {
            if (++attempts === blockedAttempt) {
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
          [{ id: "diagnostics-otel", start: () => {}, stop: exporterStop }],
          "diagnostics-otel",
          "bundled",
        ).services,
      );
      let handle!: PluginServicesHandle;
      const config = createServiceConfig();
      const starting = startPluginServices({
        registry,
        config,
        onHandle: (value) => {
          handle = value;
        },
      });
      let transition: Promise<unknown> = starting;
      let stopping: Promise<unknown> | undefined;
      try {
        if (phase === "reload") {
          await starting;
          transition = handle.reload(config, new Set(["late-resource"]));
        }
        await entered.promise;
        stopping = handle
          .stop({ strict: true, deadlineAtMs: Date.now() + 100 })
          .catch((error: unknown) => error);
        await vi.advanceTimersByTimeAsync(100);
        expect(await stopping).toBeInstanceOf(AggregateError);
        const earlyStops = stop.mock.calls.length;
        const earlyExporterStops = exporterStop.mock.calls.length;
        release.resolve();
        await transition;
        await handle.stop();
        expect(process.listenerCount(event)).toBe(listenerCount);
        expect(earlyStops).toBe(blockedAttempt - 1);
        expect(earlyExporterStops).toBe(0);
        expect(stop).toHaveBeenCalledTimes(blockedAttempt);
        expect(exporterStop).toHaveBeenCalledOnce();
        expect(order.slice(-2)).toEqual(["producer-stop", "exporter-stop"]);
      } finally {
        release.resolve();
        await Promise.allSettled([starting, transition, stopping]);
        await handle.stop();
        process.off(event, listener);
        vi.useRealTimers();
      }
    },
  );

  it("cleans a started sibling while another startup remains unsettled", async () => {
    vi.useFakeTimers();
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const event = "service-started-sibling";
    const listener = () => {};
    const before = process.listenerCount(event);
    let handle!: PluginServicesHandle;
    const starting = startPluginServices({
      registry: createRegistry([
        {
          id: "started-sibling",
          start: () => {
            process.on(event, listener);
          },
          stop: () => {
            process.off(event, listener);
          },
        },
        {
          id: "pending-start",
          start: () => {
            entered.resolve();
            return release.promise;
          },
        },
      ]),
      config: createServiceConfig(),
      onHandle: (value) => {
        handle = value;
      },
    });
    let stopping: Promise<unknown> | undefined;
    try {
      await entered.promise;
      stopping = handle
        .stop({ strict: true, deadlineAtMs: Date.now() + 100 })
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(100);
      expect(await stopping).toBeInstanceOf(AggregateError);
      expect(process.listenerCount(event)).toBe(before);
    } finally {
      release.resolve();
      await starting;
      await stopping;
      await handle.stop();
      process.off(event, listener);
      vi.useRealTimers();
    }
  });

  it.each(["ordinary", "strict-first", "strict-last"] as const)(
    "shares cleanup while preserving concurrent %s shutdown deadlines",
    async (mode) => {
      vi.useFakeTimers();
      const cleanup = createDeferredCore();
      const stop = vi.fn(() => cleanup.promise);
      const handle = await startPluginServices({
        registry: createRegistry([{ id: "service", start: () => {}, stop }]),
        config: createServiceConfig(),
      });
      const strict = { strict: true as const, deadlineAtMs: Date.now() + 100 };
      const outcomes: unknown[] = [];
      const observers = [
        handle.stop(mode === "strict-first" ? strict : undefined),
        handle.stop(mode === "strict-last" ? strict : undefined),
      ].map((promise, index) =>
        promise.then(
          () => {
            outcomes[index] = "settled";
          },
          (error: unknown) => {
            outcomes[index] = error;
          },
        ),
      );

      try {
        await vi.advanceTimersByTimeAsync(100);
        if (mode !== "ordinary") {
          const strictIndex = mode === "strict-first" ? 0 : 1;
          expect(outcomes[strictIndex]).toBeInstanceOf(AggregateError);
          expect(outcomes[1 - strictIndex]).toBeUndefined();
        }
        cleanup.resolve();
        await Promise.all(observers);
        if (mode === "ordinary") {
          expect(outcomes).toEqual(["settled", "settled"]);
        } else {
          expect(outcomes[mode === "strict-first" ? 1 : 0]).toBe("settled");
        }
        expect(stop).toHaveBeenCalledOnce();

        await handle.stop();
        expect(stop).toHaveBeenCalledOnce();
      } finally {
        cleanup.resolve();
        await Promise.all(observers);
        vi.useRealTimers();
      }
    },
  );

  it("strictly aggregates ordinary and exporter failures while draining producers first", async () => {
    const order: string[] = [];
    const ordinaryFailure = new Error("ordinary cleanup rejected");
    const exporterFailure = new Error("exporter cleanup rejected");
    const registry = createRegistry([
      {
        id: "ordinary-first",
        start: () => {},
        stop: () => {
          order.push("ordinary-first");
          emitTrustedDiagnosticEvent({
            type: "log.record",
            level: "INFO",
            message: "queued before exporter shutdown",
          });
          throw ordinaryFailure;
        },
      },
      {
        id: "ordinary-second",
        start: () => {},
        stop: () => {
          order.push("ordinary-second");
        },
      },
    ]);
    registry.services.push(
      ...createRegistry(
        [
          {
            id: "diagnostics-prometheus",
            start: () => {},
            stop: () => {
              order.push("prometheus");
            },
          },
        ],
        "diagnostics-prometheus",
        "bundled",
      ).services,
      ...createRegistry(
        [
          {
            id: "diagnostics-otel",
            start: (ctx) => {
              ctx.internalDiagnostics?.onEvent((event) => {
                if (event.type === "log.record") {
                  order.push("drained");
                }
              });
            },
            stop: () => {
              order.push("otel");
              throw exporterFailure;
            },
          },
        ],
        "diagnostics-otel",
        "bundled",
      ).services,
    );
    const handle = await startPluginServices({ registry, config: createServiceConfig() });
    const failure = await handle
      .stop({ strict: true, deadlineAtMs: Date.now() + 5_000 })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([
      expect.objectContaining({
        cause: ordinaryFailure,
        message: expect.stringContaining("plugin=plugin:test, service=ordinary-first"),
      }),
      expect.objectContaining({
        cause: exporterFailure,
        message: expect.stringContaining("plugin=diagnostics-otel, service=diagnostics-otel"),
      }),
    ]);
    expect(order).toEqual(["ordinary-second", "ordinary-first", "drained", "otel", "prometheus"]);
  });

  it("bounds strict cleanup and fences timed-out service routes, events, and health", async () => {
    vi.useFakeTimers();
    const cleanupDeferred = createDeferredCore();
    const received = vi.fn();
    const siblingStop = vi.fn();
    const broadcastPluginEvent = vi.fn();
    const lateFailures: unknown[] = [];
    const nestedRegistry = createEmptyPluginRegistry();
    let context: OpenClawPluginServiceContext | undefined;
    const registry = createRegistry([
      { id: "sibling", start: () => {}, stop: siblingStop },
      {
        id: "blocked-cleanup",
        start: (ctx) => {
          context = ctx;
          ctx.gatewayEvents?.onSessionsChanged(received);
          registerPluginHttpRoute({ path: "/owned-route", auth: "plugin", handler: vi.fn() });
        },
        stop: async (ctx) => {
          await cleanupDeferred.promise;
          ctx.serviceHealth?.reportFailure(new Error("late stale failure"));
          for (const run of [
            () => ctx.gatewayEvents?.emit("late", {}, { scope: "operator.read" }),
            () =>
              registerPluginHttpRoute({
                path: "/late-anonymous-route",
                auth: "plugin",
                handler: vi.fn(),
                throwOnFailure: true,
              }),
            () =>
              withPluginHttpRouteRegistry(nestedRegistry, () =>
                registerPluginHttpRoute({
                  path: "/late-nested-route",
                  auth: "plugin",
                  handler: vi.fn(),
                  throwOnFailure: true,
                }),
              ),
            () =>
              withPluginHttpRouteRegistry(
                nestedRegistry,
                () =>
                  registerPluginHttpRoute({
                    path: "/late-replacement-lease-route",
                    auth: "plugin",
                    handler: vi.fn(),
                    throwOnFailure: true,
                  }),
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
      const handle = await startPluginServices({
        registry,
        config: createServiceConfig(),
        broadcastPluginEvent,
      });
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
      await Promise.resolve();
      await Promise.resolve();
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
      starting = startPluginServices({
        registry,
        config: createServiceConfig(),
        broadcastPluginEvent,
      }).then((handle) => {
        settled = true;
        return handle;
      });
      await vi.advanceTimersByTimeAsync(PLUGIN_SERVICE_REPLACEMENT_STOP_TIMEOUT_MS);

      expect(settled).toBe(true);
      const handle = await starting;
      expect(siblingStart).toHaveBeenCalledOnce();
      expect(mockedLogger.error).toHaveBeenCalledWith(
        expect.stringContaining("plugin service failed (failed-start-hung-stop"),
      );
      expect(mockedLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining("plugin service stop failed (failed-start-hung-stop)"),
      );
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

  it("honors a replacement deadline inherited after ownership consumed most of its budget", async () => {
    vi.useFakeTimers();
    const broadcastPluginEvent = vi.fn();
    const cleanup = createDeferredCore();
    let context: OpenClawPluginServiceContext | undefined;
    const registry = createRegistry([
      {
        id: "late-owner",
        start: (serviceContext) => {
          context = serviceContext;
          registerPluginHttpRoute({ path: "/deadline-route", auth: "plugin", handler: vi.fn() });
        },
        stop: async (serviceContext) => {
          await cleanup.promise;
          serviceContext.gatewayEvents?.emit("late", {}, { scope: "operator.read" });
        },
      },
    ]);
    let stopping: ReturnType<PluginServicesHandle["stop"]> | undefined;

    try {
      const handle = await startPluginServices({
        registry,
        config: createServiceConfig(),
        broadcastPluginEvent,
      });
      const deadlineAtMs = Date.now() + 100;
      let failure: unknown;
      stopping = handle.stop({ strict: true, deadlineAtMs }).catch((error: unknown) => {
        failure = error;
      });

      await vi.advanceTimersByTimeAsync(99);
      expect(failure).toBeUndefined();
      expect(registry.httpRoutes).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(1);
      expect(failure).toBeInstanceOf(AggregateError);
      expect(registry.httpRoutes).toEqual([]);
      expect(() => context?.gatewayEvents?.emit("late", {}, { scope: "operator.read" })).toThrow(
        "no longer active",
      );
      expect(broadcastPluginEvent).not.toHaveBeenCalled();
    } finally {
      cleanup.resolve();
      await stopping;
      vi.useRealTimers();
    }
  });

  it("bounds strict shutdown while startup is unsettled and revokes its late continuation", async () => {
    vi.useFakeTimers();
    const startup = createDeferredCore();
    const broadcastPluginEvent = vi.fn();
    const lateFailures: unknown[] = [];
    let lifecycleHandle: PluginServicesHandle | undefined;
    const registry = createRegistry([
      {
        id: "blocked-startup",
        start: async (ctx) => {
          await startup.promise;
          ctx.serviceHealth?.reportFailure(new Error("late startup failure"));
          for (const run of [
            () => ctx.gatewayEvents?.emit("late", {}, { scope: "operator.read" }),
            () =>
              registerPluginHttpRoute({
                path: "/late-startup-route",
                auth: "plugin",
                handler: vi.fn(),
                throwOnFailure: true,
              }),
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
    const starting = startPluginServices({
      registry,
      config: createServiceConfig(),
      broadcastPluginEvent,
      onHandle: (handle) => {
        lifecycleHandle = handle;
      },
    });
    let stopping: ReturnType<PluginServicesHandle["stop"]> | undefined;

    try {
      let failure: unknown;
      stopping = lifecycleHandle!
        .stop({ strict: true, deadlineAtMs: Date.now() + 5_000 })
        .catch((error: unknown) => {
          failure = error;
        });
      await vi.advanceTimersByTimeAsync(5_000);

      expect(failure).toBeInstanceOf(AggregateError);
      expect((failure as AggregateError).errors[0]).toMatchObject({
        message: expect.stringContaining("plugin service startup settlement timed out"),
      });

      startup.resolve();
      await starting;
      await stopping;
      expect(lateFailures).toHaveLength(2);
      expect(broadcastPluginEvent).not.toHaveBeenCalled();
      expect(listPluginServiceHealthFailures(registry)).toEqual([]);
      expect(registry.httpRoutes).toEqual([]);
    } finally {
      startup.resolve();
      await starting;
      await stopping;
      vi.useRealTimers();
    }
  });

  it.each(["fulfilled", "rejected", "pending", "fulfilled-promise", "rejected-promise"] as const)(
    "does not repeat %s cleanup when startup fails after replacement settles",
    async (cleanupState) => {
      vi.useFakeTimers();
      const startup = createDeferredCore();
      const cleanup = createDeferredCore();
      const cleanupError = new Error("cleanup rejected");
      const order: string[] = [];
      const stop = vi.fn(() => {
        order.push("stop");
        if (cleanupState === "rejected") {
          throw cleanupError;
        }
        if (cleanupState === "rejected-promise") {
          return Promise.reject(cleanupError);
        }
        if (cleanupState === "fulfilled-promise") {
          return Promise.resolve();
        }
        return cleanupState === "pending" ? cleanup.promise : undefined;
      });
      let lifecycleHandle!: PluginServicesHandle;
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
        config: createServiceConfig(),
        onHandle: (handle) => {
          lifecycleHandle = handle;
        },
      });
      const stopping = lifecycleHandle.stop({
        strict: true,
        deadlineAtMs: Date.now() + PLUGIN_SERVICE_REPLACEMENT_STOP_TIMEOUT_MS,
      });
      const stopped = stopping.catch((error: unknown) => error);

      try {
        await vi.advanceTimersByTimeAsync(PLUGIN_SERVICE_REPLACEMENT_STOP_TIMEOUT_MS);
        const failure = await stopped;
        expect(failure).toBeInstanceOf(AggregateError);
        const errors = (failure as AggregateError).errors;
        expect(errors[0]).toMatchObject({
          message: expect.stringContaining("plugin service startup settlement timed out"),
        });
        expect(errors).toHaveLength(1);
        order.push("replacement-settled");
        expect(stop).not.toHaveBeenCalled();
        startup.reject(new Error("startup failed after replacement"));
        await vi.advanceTimersByTimeAsync(0);

        expect(stop).toHaveBeenCalledOnce();
        expect(order).toEqual(["start", "replacement-settled", "stop"]);
        cleanup.resolve();
        await starting;
        const finalCleanup = lifecycleHandle.stop({
          strict: true,
          deadlineAtMs: Date.now() + PLUGIN_SERVICE_REPLACEMENT_STOP_TIMEOUT_MS,
        });
        if (cleanupState === "rejected" || cleanupState === "rejected-promise") {
          const cleanupFailure = await finalCleanup.catch((error: unknown) => error);
          expect(cleanupFailure).toBeInstanceOf(AggregateError);
          const cleanupErrors = (cleanupFailure as AggregateError).errors;
          expect(cleanupErrors).toHaveLength(1);
          expect(cleanupErrors[0].cause).toBe(cleanupError);
        } else {
          await expect(finalCleanup).resolves.toBeUndefined();
        }
        mockedLogger.warn.mockClear();
        await expect(lifecycleHandle.stop()).resolves.toEqual(
          cleanupState === "rejected" || cleanupState === "rejected-promise"
            ? { errors: [cleanupError] }
            : undefined,
        );
        expect(mockedLogger.warn).not.toHaveBeenCalled();
        expect(stop).toHaveBeenCalledOnce();
      } finally {
        startup.reject(new Error("startup test cleanup"));
        cleanup.resolve();
        await starting;
        await stopped;
        vi.useRealTimers();
      }
    },
  );

  it("revokes trusted diagnostics listeners, emitters, bridges, and exporter health with their service", async () => {
    const listener = vi.fn();
    const lateListener = vi.fn();
    const traceContext = {
      traceId: "1234567890abcdef1234567890abcdef",
      spanId: "1234567890abcdef",
    };
    let context: OpenClawPluginServiceContext | undefined;
    const registry = createRegistry(
      [
        {
          id: "diagnostics-otel",
          start: (ctx) => {
            context = ctx;
            ctx.internalDiagnostics?.onEvent(listener);
            ctx.internalDiagnostics?.registerTracePropagationBridge?.({
              resolveTraceContext: () => undefined,
            });
            registerPluginHttpRoute({ path: "/exporter-route", auth: "plugin", handler: vi.fn() });
          },
        },
      ],
      "diagnostics-otel",
      "bundled",
    );
    const handle = await startPluginServices({ registry, config: createServiceConfig() });

    expect(formatPropagatedDiagnosticTraceparent(traceContext)).toBeUndefined();
    await handle.stop();

    expect(() =>
      context?.internalDiagnostics?.emit({ type: "log.record", level: "INFO", message: "late" }),
    ).toThrow("no longer active");
    expect(() => context?.internalDiagnostics?.onEvent(lateListener)).toThrow("no longer active");
    expect(() =>
      context?.internalDiagnostics?.registerTracePropagationBridge?.({
        resolveTraceContext: () => undefined,
      }),
    ).toThrow("no longer active");
    (
      context?.internalDiagnostics as
        | (NonNullable<OpenClawPluginServiceContext["internalDiagnostics"]> & {
            reportExporterHealth?: (update: DiagnosticExporterHealthUpdate) => void;
          })
        | undefined
    )?.reportExporterHealth?.({
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
    expect(registry.httpRoutes).toEqual([]);
  });
});
