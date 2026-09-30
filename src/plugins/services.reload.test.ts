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
import { createRegistry } from "./services.test-support.js";
import { createPluginRecord } from "./status.test-helpers.js";
import type { OpenClawPluginServiceContext } from "./types.js";

describe("plugin service reload", () => {
  const handles = new Set<PluginServicesHandle>();
  afterEach(async () => {
    await Promise.allSettled([...handles].map((handle) => handle.stop()));
    handles.clear();
  });

  const configFor = (endpoint: string): OpenClawConfig => ({
    diagnostics: { otel: { enabled: true, endpoint } },
  });

  it("reloads selected services without changing sibling health or capabilities", async () => {
    const contexts: OpenClawPluginServiceContext[] = [];
    let siblingContext: OpenClawPluginServiceContext | undefined;
    const stops: OpenClawConfig[] = [];
    const broadcastPluginEvent = vi.fn();
    const registry = createRegistry(
      [
        {
          id: "exporter",
          start(ctx) {
            contexts.push(ctx);
            registerPluginHttpRoute({ path: "/exporter", auth: "plugin", handler: vi.fn() });
          },
          stop(ctx) {
            stops.push(ctx.config);
          },
        },
      ],
      "exporter",
    );
    const siblingStart = vi.fn((ctx: OpenClawPluginServiceContext) => {
      siblingContext = ctx;
      ctx.serviceHealth?.reportFailure(new Error("unrelated service failure"));
    });
    registry.services.push(
      ...createRegistry([{ id: "sibling", start: siblingStart }], "sibling").services,
    );
    const first = configFor("https://first.example");
    const next = configFor("https://next.example");
    const handle = await startPluginServices({ registry, config: first, broadcastPluginEvent });
    handles.add(handle);
    await handle.reload(next, new Set(["exporter"]));
    expect(contexts.map((ctx) => ctx.config)).toEqual([first, next]);
    expect(stops).toEqual([first]);
    expect(siblingStart).toHaveBeenCalledOnce();
    expect(registry.httpRoutes).toHaveLength(1);
    expect(() => contexts[0]?.gatewayEvents?.emit("late", {}, { scope: "operator.read" })).toThrow(
      "no longer active",
    );
    contexts[0]?.serviceHealth?.reportFailure(new Error("retired exporter"));
    expect(listPluginServiceHealthFailures(registry)).toMatchObject([
      { pluginId: "sibling", error: "unrelated service failure" },
    ]);
    siblingContext?.gatewayEvents?.emit("still_alive", {}, { scope: "operator.read" });
    contexts[1]?.gatewayEvents?.emit("replacement", {}, { scope: "operator.read" });
    expect(broadcastPluginEvent).toHaveBeenCalledTimes(2);
    await handle.stop();
    expect(stops).toEqual([first, next]);
    expect(registry.httpRoutes).toEqual([]);
  });

  it("rejects a queued reload when a selective stop has already claimed its service", async () => {
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const contexts = new Map<string, OpenClawPluginServiceContext>();
    const starts = vi.fn((ctx: OpenClawPluginServiceContext) => {
      contexts.set("exporter", ctx);
    });
    const registry = createRegistry(
      [
        {
          id: "exporter",
          start: starts,
          stop: async () => {
            entered.resolve();
            await release.promise;
          },
        },
      ],
      "exporter",
    );
    registry.services.push(
      ...createRegistry(
        [
          {
            id: "sibling",
            start: (ctx) => {
              contexts.set("sibling", ctx);
            },
          },
        ],
        "sibling",
      ).services,
    );
    const broadcastPluginEvent = vi.fn();
    const handle = await startPluginServices({ registry, config: {}, broadcastPluginEvent });
    handles.add(handle);
    const reloading = handle.reload({}, new Set(["exporter"])).catch((error: unknown) => error);
    const stopping = handle.stop({
      strict: true,
      pluginIds: new Set(["exporter"]),
      deadlineAtMs: Date.now() + 5_000,
    });
    try {
      await entered.promise;
      release.resolve();
      await stopping;
      expect(await reloading).toMatchObject({ message: expect.stringContaining("stopping") });
      expect(starts).toHaveBeenCalledOnce();
      contexts.get("sibling")!.gatewayEvents!.emit("alive", {}, { scope: "operator.read" });
      expect(() =>
        contexts.get("exporter")!.gatewayEvents!.emit("stale", {}, { scope: "operator.read" }),
      ).toThrow("no longer active");
      expect(broadcastPluginEvent).toHaveBeenCalledOnce();
    } finally {
      release.resolve();
      await Promise.allSettled([reloading, stopping]);
    }
  });

  it("bounds candidate startup and retains raw cleanup across retry", async () => {
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
    const registry = createRegistry(
      [
        {
          id: "held",
          async start(context) {
            contexts.push(context);
            registerPluginHttpRoute({ path: "/traced-service", auth: "plugin", handler: vi.fn() });
            entered.resolve();
            await release.promise;
            process.on(event, listener);
          },
          stop,
        },
        { id: "queued", start: queuedStart },
      ],
      "candidate",
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
    const operation = start().catch((error: unknown) => error);
    let stopping: Promise<unknown> | undefined;
    try {
      await entered.promise;
      await vi.advanceTimersByTimeAsync(PLUGIN_SERVICE_REPLACEMENT_STOP_TIMEOUT_MS);
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
      expect(() =>
        contexts[0]!.gatewayEvents!.emit("late", {}, { scope: "operator.read" }),
      ).toThrow("no longer active");
      await expect(start()).rejects.toThrow("cleanup remains pending");
      expect(contexts).toHaveLength(1);
      let stopped = false;
      stopping = current.stop().then(() => {
        stopped = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(stopped).toBe(false);
      release.resolve();
      await stopping;
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
      await stopping;
      await Promise.allSettled([...handles].map((handle) => handle.stop()));
      process.off(event, listener);
      vi.useRealTimers();
    }
  });

  it("stops late managed resources before disposing their plugin instance", async () => {
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
    registry.services.push(
      ...createRegistry(
        [
          instance.wrap({
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
        ],
        record.id,
      ).services,
    );
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
      const registry = createRegistry([service, sibling]);
      const successorConfig: OpenClawConfig = {};
      const previous = await startPluginServices({
        registry,
        config: {},
        getCronService: () => undefined,
      });
      const reloading = previous.reload({}, new Set([service.id]));
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
    { phase: "starting", rejects: false },
    { phase: "ready", rejects: true },
  ] as const)(
    "owns a selective stop across $phase handoff (rejects: $rejects)",
    async ({ phase, rejects }) => {
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const failure = new Error("selected cleanup rejected");
      const contexts: Record<"selected" | "sibling", OpenClawPluginServiceContext[]> = {
        selected: [],
        sibling: [],
      };
      const stopped = {
        selected: vi.fn(() => {
          if (rejects) {
            throw failure;
          }
        }),
        sibling: vi.fn(),
      };
      const registry = createEmptyPluginRegistry();
      for (const id of ["selected", "sibling"] as const) {
        registry.services.push(
          ...createRegistry(
            [
              {
                id,
                start(context) {
                  contexts[id].push(context);
                  if (id === "selected" && phase === "starting" && contexts[id].length === 1) {
                    entered.resolve();
                    return release.promise;
                  }
                  return undefined;
                },
                stop: stopped[id],
              },
            ],
            id,
          ).services,
        );
      }
      const handles: PluginServicesHandle[] = [];
      const start = (previous?: PluginServicesHandle) =>
        startPluginServices({
          registry,
          config: {},
          getCronService: () => undefined,
          previous,
          onHandle: (handle) => handles.push(handle),
        });
      const stop = (handle: PluginServicesHandle) =>
        handle.stop({
          strict: true,
          deadlineAtMs: Date.now() + 5_000,
          pluginIds: new Set(["selected"]),
        });
      const starting = start();
      const previous = handles[0]!;
      let stopOutcome: Promise<unknown> | undefined;
      try {
        await (phase === "starting" ? entered.promise : starting);
        const oldContext = contexts.selected[0]!;
        stopOutcome = stop(previous).catch((error: unknown) => error);
        expect(() => oldContext.getCron?.()).toThrow("stopping");
        const successor = await start(previous);
        release.resolve();
        await starting;
        const outcome = await stopOutcome;
        expect(stopped.selected).toHaveBeenCalledOnce();
        expect(() => oldContext.getCron?.()).toThrow("no longer active");
        expect(stopped.sibling).not.toHaveBeenCalled();
        expect(contexts.selected).toHaveLength(1);
        expect(contexts.sibling).toHaveLength(1);
        if (rejects) {
          expect(outcome).toBeInstanceOf(AggregateError);
          await expect(stop(successor)).rejects.toThrow(
            "plugin service replacement cleanup failed",
          );
          expect(stopped.selected).toHaveBeenCalledOnce();
        } else {
          expect(outcome).toBeUndefined();
          await start(successor);
          expect(contexts.selected).toHaveLength(2);
          expect(contexts.sibling).toHaveLength(1);
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
      config: {},
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
        config: {},
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
      await started.reload({}, new Set(["first", "sibling"]));
      expect(replacement.start).toHaveBeenCalledTimes(2);
      expect(sibling.start).toHaveBeenCalledTimes(2);
    } finally {
      await current?.stop();
      await previous.stop();
    }
    expect(sibling.stop).toHaveBeenCalledTimes(2);
    expect(replacement.stop).toHaveBeenCalledTimes(2);
  });
});
