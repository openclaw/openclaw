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
  startPluginServices,
  type PluginServicesHandle,
} from "./services.js";
import { createRegistry, createServiceConfig } from "./services.test-support.js";
import { createPluginRecord } from "./status.test-helpers.js";
import type { OpenClawPluginService, OpenClawPluginServiceContext } from "./types.js";

describe("plugin service reload", () => {
  const handles = new Set<PluginServicesHandle>();
  afterEach(async () => {
    await Promise.allSettled([...handles].map((handle) => handle.stop()));
    handles.clear();
  });

  const configFor = (endpoint: string): OpenClawConfig => ({
    diagnostics: { otel: { enabled: true, endpoint } },
  });

  it("replaces only selected services, retiring their routes and capabilities without losing sibling health", async () => {
    const contexts: OpenClawPluginServiceContext[] = [];
    const siblingContexts: OpenClawPluginServiceContext[] = [];
    const stops: OpenClawConfig[] = [];
    const broadcastPluginEvent = vi.fn();
    const registry = createEmptyPluginRegistry();
    registry.services.push(
      {
        pluginId: "exporter",
        origin: "workspace",
        source: "test",
        service: {
          id: "exporter",
          start(ctx) {
            contexts.push(ctx);
            registerPluginHttpRoute({ path: "/exporter", auth: "plugin", handler: vi.fn() });
          },
          stop(ctx) {
            stops.push(ctx.config);
          },
        },
      },
      {
        pluginId: "sibling",
        origin: "workspace",
        source: "test",
        service: {
          id: "sibling",
          start(ctx) {
            siblingContexts.push(ctx);
            ctx.serviceHealth?.reportFailure(new Error("unrelated service failure"));
          },
        },
      },
    );
    const first = configFor("https://first.example");
    const next = configFor("https://next.example");
    const handle = await startPluginServices({ registry, config: first, broadcastPluginEvent });
    handles.add(handle);
    await handle.reload(next, new Set(["exporter"]));

    expect(contexts.map((ctx) => ctx.config)).toEqual([first, next]);
    expect(stops).toEqual([first]);
    expect(siblingContexts).toHaveLength(1);
    expect(registry.httpRoutes).toHaveLength(1);
    expect(() => contexts[0]?.gatewayEvents?.emit("late", {}, { scope: "operator.read" })).toThrow(
      "no longer active",
    );
    contexts[0]?.serviceHealth?.reportFailure(new Error("retired exporter"));
    expect(listPluginServiceHealthFailures(registry)).toMatchObject([
      { pluginId: "sibling", error: "unrelated service failure" },
    ]);
    siblingContexts[0]?.gatewayEvents?.emit("still_alive", {}, { scope: "operator.read" });
    contexts[1]?.gatewayEvents?.emit("replacement", {}, { scope: "operator.read" });
    expect(broadcastPluginEvent).toHaveBeenCalledTimes(2);

    await handle.stop();
    expect(stops).toEqual([first, next]);
    expect(registry.httpRoutes).toEqual([]);
  });

  it("does not start a selected successor when Gateway shutdown overtakes its cleanup", async () => {
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const start = vi.fn();
    const stop = vi.fn(() => {
      entered.resolve();
      return release.promise;
    });
    const registry = createEmptyPluginRegistry();
    registry.services.push({
      pluginId: "exporter",
      origin: "workspace",
      source: "test",
      service: { id: "exporter", start, stop },
    });
    const handle = await startPluginServices({
      registry,
      config: configFor("https://first.example"),
    });
    handles.add(handle);
    let result: Promise<unknown> | undefined;
    try {
      result = handle
        .reload(configFor("https://next.example"), new Set(["exporter"]))
        .catch((error: unknown) => error);
      await entered.promise;
      const stopping = handle.stop();
      release.resolve();
      await Promise.all([result, stopping]);
      expect(start).toHaveBeenCalledOnce();
      expect(stop).toHaveBeenCalledOnce();
    } finally {
      release.resolve();
      await result;
    }
  });

  it.each(["stop", "start"] as const)(
    "reports selected service %s failure while leaving unrelated services live",
    async (phase) => {
      let starts = 0;
      const siblingStop = vi.fn();
      const registry = createEmptyPluginRegistry();
      registry.services.push(
        {
          pluginId: "exporter",
          origin: "workspace",
          source: "test",
          service: {
            id: "exporter",
            start() {
              if (++starts > 1 && phase === "start") {
                throw new Error("replacement start rejected");
              }
            },
            stop() {
              if (phase === "stop") {
                throw new Error("replacement stop rejected");
              }
            },
          },
        },
        {
          pluginId: "sibling",
          origin: "workspace",
          source: "test",
          service: { id: "sibling", start() {}, stop: siblingStop },
        },
      );
      const handle = await startPluginServices({
        registry,
        config: configFor("https://first.example"),
      });
      handles.add(handle);
      await expect(
        handle.reload(configFor("https://next.example"), new Set(["exporter"])),
      ).rejects.toThrow();
      expect(starts).toBe(phase === "start" ? 2 : 1);
      expect(siblingStop).not.toHaveBeenCalled();
    },
  );

  it.each(["exporter", "sibling"] as const)(
    "preserves a selective %s stop requested before queued reload admission",
    async (stoppedPlugin) => {
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const contexts = {
        exporter: [] as OpenClawPluginServiceContext[],
        sibling: [] as OpenClawPluginServiceContext[],
      };
      const registry = createEmptyPluginRegistry();
      for (const id of ["exporter", "sibling"] as const) {
        registry.services.push({
          pluginId: id,
          origin: "workspace",
          source: "test",
          service: {
            id,
            start: (ctx) => {
              contexts[id].push(ctx);
            },
            stop: async () => {
              entered.resolve();
              await release.promise;
            },
          },
        });
      }
      const broadcastPluginEvent = vi.fn();
      const handle = await startPluginServices({ registry, config: {}, broadcastPluginEvent });
      handles.add(handle);
      // Stop owns admission synchronously, before the queued reload gets its first microtask.
      const reloading = handle
        .reload(configFor("https://next.example"), new Set(["exporter"]))
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      const stopping = handle.stop({
        strict: true,
        deadlineAtMs: Date.now() + PLUGIN_SERVICE_REPLACEMENT_STOP_TIMEOUT_MS,
        pluginIds: new Set([stoppedPlugin]),
      });
      try {
        await entered.promise;
        release.resolve();
        await stopping;
        const result = await reloading;
        if (stoppedPlugin === "exporter") {
          expect(result).toMatchObject({ message: expect.stringContaining("stopping") });
          expect(contexts.exporter).toHaveLength(1);
          contexts.sibling[0]?.gatewayEvents?.emit("alive", {}, { scope: "operator.read" });
        } else {
          expect(result).toBeUndefined();
          expect(contexts.exporter).toHaveLength(2);
          contexts.exporter[1]?.gatewayEvents?.emit("alive", {}, { scope: "operator.read" });
        }
        expect(contexts.sibling).toHaveLength(1);
        expect(() =>
          contexts[stoppedPlugin][0]?.gatewayEvents?.emit("stale", {}, { scope: "operator.read" }),
        ).toThrow("no longer active");
        expect(broadcastPluginEvent).toHaveBeenCalledOnce();
      } finally {
        release.resolve();
        await Promise.allSettled([reloading, stopping]);
      }
    },
  );

  it("applies each queued service reload to the current service instance", async () => {
    const configs: OpenClawConfig[] = [];
    const stop = vi.fn();
    const registry = createEmptyPluginRegistry();
    registry.services.push({
      pluginId: "exporter",
      source: "test",
      origin: "workspace",
      service: {
        id: "exporter",
        start: (ctx) => {
          configs.push(ctx.config);
        },
        stop,
      },
    });
    const initial = configFor("https://initial.example");
    const first = configFor("https://first.example");
    const second = configFor("https://second.example");
    const handle = await startPluginServices({ registry, config: initial });
    handles.add(handle);
    await Promise.all([
      handle.reload(first, new Set(["exporter"])),
      handle.reload(second, new Set(["exporter"])),
    ]);
    expect(configs).toEqual([initial, first, second]);
    expect(stop).toHaveBeenCalledTimes(2);
  });

  it("reports retained failed cleanup on a later reload instead of silently skipping its owner", async () => {
    const start = vi.fn();
    const stop = vi.fn(() => {
      throw new Error("cleanup refused");
    });
    const registry = createEmptyPluginRegistry();
    registry.services.push({
      pluginId: "exporter",
      origin: "workspace",
      source: "test",
      service: { id: "exporter", start, stop },
    });
    const handle = await startPluginServices({ registry, config: {} });
    handles.add(handle);
    await expect(handle.reload({}, new Set(["exporter"]))).rejects.toThrow();
    await expect(handle.reload({}, new Set(["exporter"]))).rejects.toThrow();
    expect(start).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    "bounds candidate startup while retaining raw work through cleanup (close before timeout=%s)",
    async (closeEarly) => {
      vi.useFakeTimers();
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const event = "plugin-candidate-late-start";
      const listener = () => {};
      const before = process.listenerCount(event);
      const contexts: OpenClawPluginServiceContext[] = [];
      const stop = vi.fn(() => {
        process.off(event, listener);
      });
      const queuedStart = vi.fn();
      const registry = createEmptyPluginRegistry();
      registry.services.push(
        {
          pluginId: "candidate",
          origin: "workspace",
          source: "test",
          service: {
            id: "held",
            start: async (context) => {
              contexts.push(context);
              registerPluginHttpRoute({
                path: "/traced-service",
                auth: "plugin",
                handler: vi.fn(),
              });
              entered.resolve();
              await release.promise;
              process.on(event, listener);
            },
            stop,
          },
        },
        {
          pluginId: "candidate",
          origin: "workspace",
          source: "test",
          service: { id: "queued", start: queuedStart },
        },
      );
      const startupTrace = createGatewayStartupTrace(createSubsystemLogger("test/service-startup"));
      const broadcastPluginEvent = vi.fn();
      let current!: PluginServicesHandle;
      const start = () =>
        startPluginServices({
          registry,
          config: {},
          startupTrace,
          broadcastPluginEvent,
          previous: current,
          throwOnStartError: true,
          onHandle: (handle) => {
            current = handle;
            handles.add(handle);
          },
        });
      let outcome: unknown;
      const operation = start().then(
        () => {
          outcome = "completed";
        },
        (error: unknown) => {
          outcome = error;
        },
      );
      const stops: ReturnType<PluginServicesHandle["stop"]>[] = [];
      try {
        await entered.promise;
        if (closeEarly) {
          stops.push(current.stop());
        }
        await vi.advanceTimersByTimeAsync(PLUGIN_SERVICE_REPLACEMENT_STOP_TIMEOUT_MS);
        expect(outcome).toMatchObject({
          errors: expect.arrayContaining([
            expect.objectContaining({
              message: expect.stringContaining("plugin service startup timed out"),
            }),
          ]),
        });
        expect(stop).not.toHaveBeenCalled();
        expect(queuedStart).not.toHaveBeenCalled();
        expect(registry.httpRoutes).toEqual([]);
        expect(() =>
          contexts[0]!.gatewayEvents!.emit("late", {}, { scope: "operator.read" }),
        ).toThrow("no longer active");
        // A successor inherits the still-owned attempt; it cannot turn timeout
        // into a second start while the original can still acquire resources.
        await expect(start()).rejects.toThrow("cleanup remains pending");
        expect(contexts).toHaveLength(1);
        let stopped = false;
        stops.push(
          current.stop().then(() => {
            stopped = true;
          }),
        );
        await vi.advanceTimersByTimeAsync(0);
        expect(stopped).toBe(false);
        release.resolve();
        await operation;
        await Promise.all(stops);
        expect(stop).toHaveBeenCalledOnce();
        expect(process.listenerCount(event)).toBe(before);
        expect(queuedStart).not.toHaveBeenCalled();

        await start();
        expect(contexts).toHaveLength(2);
        expect(queuedStart).toHaveBeenCalledOnce();
        contexts[1]!.gatewayEvents!.emit("ready", {}, { scope: "operator.read" });
        expect(broadcastPluginEvent).toHaveBeenCalledOnce();
        await current.stop();
        expect(stop).toHaveBeenCalledTimes(2);
        expect(process.listenerCount(event)).toBe(before);
      } finally {
        release.resolve();
        await operation;
        await Promise.allSettled(stops);
        await Promise.allSettled([...handles].map((handle) => handle.stop()));
        process.off(event, listener);
        vi.useRealTimers();
      }
    },
  );

  it("stops resources acquired by a managed service after its startup deadline", async () => {
    vi.useFakeTimers();
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const event = "plugin-managed-service-late-start";
    const listener = () => {};
    const before = process.listenerCount(event);
    const registry = createEmptyPluginRegistry();
    const record = createPluginRecord({ id: "candidate" });
    registry.plugins.push(record);
    const instance = new PluginInstance(record.id, { record, registry });
    const dispatch = vi.fn();
    const invoke = instance.wrap(dispatch);
    let lateFailure: unknown;
    const stop = vi.fn(() => {
      process.off(event, listener);
    });
    registry.services.push({
      pluginId: record.id,
      origin: "workspace",
      source: "test",
      service: instance.wrap({
        id: "late-start",
        async start() {
          entered.resolve();
          await release.promise;
          try {
            invoke();
          } catch (error) {
            lateFailure = error;
          }
          process.on(event, listener);
        },
        stop,
      }),
    });
    const startup = startPluginServices({
      registry,
      config: {},
      throwOnStartError: true,
      onHandle: (handle) => handles.add(handle),
    }).catch((error: unknown) => error);
    let retirement: Promise<unknown> | undefined;
    try {
      await entered.promise;
      await vi.advanceTimersByTimeAsync(PLUGIN_SERVICE_REPLACEMENT_STOP_TIMEOUT_MS);
      expect(await startup).toBeInstanceOf(AggregateError);
      retirement = instance.dispose();
      await vi.advanceTimersByTimeAsync(PLUGIN_SERVICE_REPLACEMENT_STOP_TIMEOUT_MS);
      expect(() => instance.run(() => "retired dispatch")).toThrow("reloaded or disabled");
      release.resolve();
      await Promise.allSettled([...handles].map((handle) => handle.stop()));
      expect(dispatch).not.toHaveBeenCalled();
      expect(lateFailure).toMatchObject({
        message: expect.stringContaining("reloaded or disabled"),
      });
      expect(stop).toHaveBeenCalledOnce();
      expect(process.listenerCount(event)).toBe(before);
      await retirement;
      expect(instance.lifecycle.signal.aborted).toBe(true);
    } finally {
      release.resolve();
      await startup;
      await Promise.allSettled([...handles].map((handle) => handle.stop()));
      await retirement;
      process.off(event, listener);
      vi.useRealTimers();
    }
  });

  it.each([false, true])(
    "transfers an admitted reload restart with its handle (successor stopped=%s)",
    async (stopSuccessor) => {
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const contexts: OpenClawPluginServiceContext[] = [];
      const service = {
        id: "reloading",
        start: vi.fn((context: OpenClawPluginServiceContext) => {
          contexts.push(context);
        }),
        stop: vi.fn(async () => {
          entered.resolve();
          await release.promise;
        }),
      };
      const sibling = { id: "sibling", start: vi.fn(), stop: vi.fn() };
      const registry = createEmptyPluginRegistry();
      for (const entry of [service, sibling]) {
        registry.services.push({
          pluginId: "plugin:test",
          service: entry,
          source: "test",
          origin: "workspace",
          rootDir: "/plugins/test-plugin",
        });
      }
      const initialConfig: OpenClawConfig = {};
      const reloadConfig: OpenClawConfig = {};
      const successorConfig: OpenClawConfig = {};
      const previous = await startPluginServices({
        registry,
        config: initialConfig,
        getCronService: () => undefined,
      });
      const reloading = previous.reload(reloadConfig, new Set([service.id]));
      let successor: PluginServicesHandle | undefined;
      let starting: Promise<PluginServicesHandle> | undefined;
      let stopping: ReturnType<PluginServicesHandle["stop"]> | undefined;
      try {
        await entered.promise;
        const nextRegistry = createEmptyPluginRegistry();
        nextRegistry.services.push(...registry.services);
        starting = startPluginServices({
          registry: nextRegistry,
          config: successorConfig,
          getCronService: () => undefined,
          previous,
          onHandle: (handle) => {
            successor = handle;
          },
        });
        if (stopSuccessor) {
          stopping = successor!.stop();
        }
        expect(service.start).toHaveBeenCalledOnce();
        release.resolve();
        await Promise.all([reloading, starting, stopping]);
        expect(service.start).toHaveBeenCalledTimes(stopSuccessor ? 1 : 2);
        expect(service.stop).toHaveBeenCalledOnce();
        expect(() => contexts[0]!.getCron?.()).toThrow("no longer active");
        expect(sibling.start).toHaveBeenCalledOnce();
        expect(sibling.stop).toHaveBeenCalledTimes(stopSuccessor ? 1 : 0);
        await previous.stop();
        if (!stopSuccessor) {
          expect(contexts[1]!.config).toBe(successorConfig);
          expect(() => contexts[1]!.getCron?.()).not.toThrow();
        }
      } finally {
        release.resolve();
        await Promise.allSettled([reloading, starting, stopping]);
        await successor?.stop();
        await previous.stop();
      }
      expect(service.stop).toHaveBeenCalledTimes(stopSuccessor ? 1 : 2);
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
    { phase: "ready", selection: "all", rejects: false },
    { phase: "ready", selection: "selected", rejects: false },
    { phase: "starting", selection: "selected", rejects: false },
    { phase: "ready", selection: "selected", rejects: true },
  ] as const)(
    "owns a requested $selection stop across $phase handoff (rejects: $rejects)",
    async ({ phase, selection, rejects }) => {
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const failure = new Error("selected cleanup rejected");
      const contexts = new Map<string, OpenClawPluginServiceContext[]>();
      const stopped = { selected: vi.fn(), sibling: vi.fn() };
      stopped.selected.mockImplementation(() => {
        if (rejects) {
          throw failure;
        }
      });
      const makeService = (id: "selected" | "sibling"): OpenClawPluginService => ({
        id,
        start: (context) => {
          const issued = contexts.get(id) ?? [];
          issued.push(context);
          contexts.set(id, issued);
          if (id === "selected" && phase === "starting" && issued.length === 1) {
            entered.resolve();
            return release.promise;
          }
          return undefined;
        },
        stop: stopped[id],
      });
      const registry = createRegistry([makeService("selected")], "selected");
      registry.services.push(...createRegistry([makeService("sibling")], "sibling").services);
      const handles: PluginServicesHandle[] = [];
      let previous!: PluginServicesHandle;
      const starting = startPluginServices({
        registry,
        config: createServiceConfig(),
        getCronService: () => undefined,
        onHandle: (handle) => {
          previous = handle;
          handles.push(handle);
        },
      });
      let stopOutcome: Promise<unknown> | undefined;
      try {
        if (phase === "starting") {
          await entered.promise;
        } else {
          await starting;
        }
        const oldContext = contexts.get("selected")![0]!;
        stopOutcome = previous
          .stop(
            selection === "selected"
              ? { strict: true, deadlineAtMs: Date.now() + 5_000, pluginIds: new Set(["selected"]) }
              : undefined,
          )
          .catch((error: unknown) => error);
        expect(() => oldContext.getCron?.()).toThrow("stopping");
        const successor = await startPluginServices({
          registry,
          config: createServiceConfig(),
          getCronService: () => undefined,
          previous,
          onHandle: (handle) => handles.push(handle),
        });
        release.resolve();
        await starting;
        const outcome = await stopOutcome;
        expect(stopped.selected).toHaveBeenCalledOnce();
        expect(() => oldContext.getCron?.()).toThrow("no longer active");
        expect(stopped.sibling).toHaveBeenCalledTimes(selection === "all" ? 1 : 0);
        expect(contexts.get("selected")).toHaveLength(1);
        expect(contexts.get("sibling")).toHaveLength(1);
        if (rejects) {
          expect(outcome).toBeInstanceOf(AggregateError);
          await expect(
            successor.stop({
              strict: true,
              deadlineAtMs: Date.now() + 5_000,
              pluginIds: new Set(["selected"]),
            }),
          ).rejects.toThrow("plugin service replacement cleanup failed");
          expect(stopped.selected).toHaveBeenCalledOnce();
        } else {
          expect(outcome).toBeUndefined();
          await startPluginServices({
            registry,
            config: createServiceConfig(),
            getCronService: () => undefined,
            previous: successor,
            onHandle: (handle) => handles.push(handle),
          });
          expect(contexts.get("selected")).toHaveLength(2);
          expect(() => contexts.get("selected")![1]!.getCron?.()).not.toThrow();
          expect(contexts.get("sibling")).toHaveLength(selection === "all" ? 2 : 1);
        }
      } finally {
        release.resolve();
        await starting;
        await stopOutcome;
        for (const handle of handles.toReversed()) {
          await handle.stop();
        }
      }
    },
  );

  it("transfers an unchanged service without restarting it and stops only the replaced owner", async () => {
    let dependencyReady = false;
    const startDependency = () => {
      dependencyReady = true;
    };
    const stopDependency = () => {
      dependencyReady = false;
    };
    const first = { id: "first", start: vi.fn(startDependency), stop: vi.fn(stopDependency) };
    const sibling = {
      id: "sibling",
      start: vi.fn(() => {
        if (!dependencyReady) {
          throw new Error("dependency must start before its consumer");
        }
      }),
      stop: vi.fn(),
    };
    const replacement = {
      id: "first",
      start: vi.fn(startDependency),
      stop: vi.fn(stopDependency),
    };
    const oldRegistry = createRegistry([first], "first");
    const siblingRegistration = createRegistry([sibling], "sibling").services[0]!;
    oldRegistry.services.push(siblingRegistration);
    const previous = await startPluginServices({
      registry: oldRegistry,
      config: createServiceConfig(),
    });
    await previous.stop({
      strict: true,
      deadlineAtMs: Date.now() + 5_000,
      pluginIds: new Set(["first"]),
    });
    const nextRegistry = createRegistry([replacement], "first");
    nextRegistry.services.push(siblingRegistration);
    let current: PluginServicesHandle | undefined;
    try {
      const started = await startPluginServices({
        registry: nextRegistry,
        config: createServiceConfig(),
        previous,
        onHandle: (handle) => {
          current = handle;
        },
        throwOnStartError: true,
      });
      expect(first.stop).toHaveBeenCalledOnce();
      expect(replacement.start).toHaveBeenCalledOnce();
      expect(sibling.start).toHaveBeenCalledOnce();
      expect(sibling.stop).not.toHaveBeenCalled();
      await started.reload(createServiceConfig(), new Set(["first", "sibling"]));
      expect(replacement.start).toHaveBeenCalledTimes(2);
      expect(sibling.start).toHaveBeenCalledTimes(2);
    } finally {
      await current?.stop();
      await previous.stop();
    }
    expect(sibling.stop).toHaveBeenCalledTimes(2);
    expect(replacement.stop).toHaveBeenCalledTimes(2);
  });

  it.each(["queued registration", "failed retained startup"] as const)(
    "keeps one service owner after handoff with %s",
    async (outcome) => {
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const ready = { id: "ready", start: vi.fn(), stop: vi.fn() };
      let attempts = 0;
      const blocked = {
        id: "blocked",
        start: vi.fn(async () => {
          const attempt = ++attempts;
          entered.resolve();
          await release.promise;
          if (outcome === "failed retained startup" && attempt === 1) {
            throw new Error("retained startup rejected");
          }
        }),
        stop: vi.fn(),
      };
      const queued = { id: "queued", start: vi.fn(), stop: vi.fn() };
      const previousRegistry = createRegistry([
        ready,
        blocked,
        ...(outcome === "queued registration" ? [queued] : []),
      ]);
      let previous!: PluginServicesHandle;
      let successor: PluginServicesHandle | undefined;
      const starting = startPluginServices({
        registry: previousRegistry,
        config: createServiceConfig(),
        onHandle: (handle) => {
          previous = handle;
        },
      });
      try {
        await entered.promise;
        const registry = createEmptyPluginRegistry();
        registry.services.push(...previousRegistry.services);
        successor = await startPluginServices({
          registry,
          config: createServiceConfig(),
          previous,
        });
        release.resolve();
        await starting;
        expect(ready.start).toHaveBeenCalledOnce();
        expect(blocked.start).toHaveBeenCalledOnce();
        expect(queued.start).toHaveBeenCalledTimes(outcome === "queued registration" ? 1 : 0);
        expect(blocked.stop).toHaveBeenCalledTimes(outcome === "failed retained startup" ? 1 : 0);
        const transferred = successor;
        successor = await startPluginServices({
          registry,
          config: createServiceConfig(),
          previous: transferred,
        });
        await transferred.stop();
        await previous.stop();
        expect(blocked.start).toHaveBeenCalledOnce();
        if (outcome === "failed retained startup") {
          await successor.reload(createServiceConfig(), new Set([blocked.id]));
          expect(blocked.start).toHaveBeenCalledTimes(2);
        }
        expect(ready.start).toHaveBeenCalledOnce();
        expect(ready.stop).not.toHaveBeenCalled();
        expect(queued.stop).not.toHaveBeenCalled();
      } finally {
        release.resolve();
        await starting;
        await previous.stop();
        await successor?.stop();
      }
      expect(ready.stop).toHaveBeenCalledOnce();
      expect(blocked.stop).toHaveBeenCalledTimes(outcome === "failed retained startup" ? 2 : 1);
      expect(queued.stop).toHaveBeenCalledTimes(outcome === "queued registration" ? 1 : 0);
    },
  );

  it("keeps unchanged services with the issued handle when a candidate cannot start", async () => {
    const sibling = { id: "sibling", start: vi.fn(), stop: vi.fn() };
    const oldRegistry = createRegistry([sibling], "sibling");
    const previous = await startPluginServices({
      registry: oldRegistry,
      config: createServiceConfig(),
    });
    const broken = {
      id: "broken",
      start: () => {
        throw new Error("candidate failed");
      },
      stop: vi.fn(),
    };
    const nextRegistry = createRegistry([broken], "broken");
    nextRegistry.services.push(...oldRegistry.services);
    let issued: PluginServicesHandle | undefined;
    try {
      await expect(
        startPluginServices({
          registry: nextRegistry,
          config: createServiceConfig(),
          previous,
          onHandle: (handle) => {
            issued = handle;
          },
          throwOnStartError: true,
        }),
      ).rejects.toThrow("plugin services failed to start");
      expect(issued).toBeDefined();
      expect(broken.stop).toHaveBeenCalledOnce();
      expect(sibling.start).toHaveBeenCalledOnce();
      expect(sibling.stop).not.toHaveBeenCalled();
      await previous.stop();
      expect(sibling.stop).not.toHaveBeenCalled();
      await issued?.stop();
      expect(sibling.stop).toHaveBeenCalledOnce();
    } finally {
      await issued?.stop();
      await previous.stop();
    }
  });

  it.each(["ready", "starting"] as const)(
    "selectively stops the %s service without revoking its sibling",
    async (selected) => {
      vi.useFakeTimers();
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const contexts = new Map<string, OpenClawPluginServiceContext>();
      const stops = { ready: vi.fn(), starting: vi.fn() };
      const registry = createRegistry(
        [
          {
            id: "ready",
            start: (ctx) => {
              contexts.set("ready", ctx);
            },
            stop: stops.ready,
          },
        ],
        "ready",
      );
      registry.services.push(
        ...createRegistry(
          [
            {
              id: "starting",
              start: async (ctx) => {
                contexts.set("starting", ctx);
                entered.resolve();
                await release.promise;
              },
              stop: stops.starting,
            },
          ],
          "starting",
        ).services,
      );
      const broadcastPluginEvent = vi.fn();
      let handle!: PluginServicesHandle;
      const starting = startPluginServices({
        registry,
        config: createServiceConfig(),
        broadcastPluginEvent,
        onHandle: (issued) => {
          handle = issued;
        },
      });
      let stopping: Promise<unknown> | undefined;
      try {
        await entered.promise;
        stopping = handle
          .stop({ strict: true, deadlineAtMs: Date.now() + 5_000, pluginIds: new Set([selected]) })
          .catch((error: unknown) => error);
        await vi.advanceTimersByTimeAsync(5_000);
        const result = await stopping;
        if (selected === "ready") {
          expect(result).toBeUndefined();
        } else {
          expect(result).toBeInstanceOf(AggregateError);
          expect((result as AggregateError).errors[0]).toMatchObject({
            message: expect.stringContaining("plugin service startup settlement timed out"),
          });
        }
        const sibling = selected === "ready" ? "starting" : "ready";
        expect(stops[selected]).toHaveBeenCalledTimes(selected === "ready" ? 1 : 0);
        expect(stops[sibling]).not.toHaveBeenCalled();
        expect(() =>
          contexts
            .get(sibling)!
            .gatewayEvents!.emit("still-active", {}, { scope: "operator.read" }),
        ).not.toThrow();
        expect(broadcastPluginEvent).toHaveBeenCalledOnce();
      } finally {
        release.resolve();
        await starting;
        await stopping;
        await handle.stop();
        vi.useRealTimers();
      }
      expect(stops.ready).toHaveBeenCalledOnce();
      expect(stops.starting).toHaveBeenCalledOnce();
    },
  );
});
