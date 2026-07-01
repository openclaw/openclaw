// Covers plugin service registration and lookup behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginOrigin } from "./plugin-origin.types.js";
import { createEmptyPluginRegistry } from "./registry.js";
import type {
  OpenClawPluginService,
  OpenClawPluginServiceContext,
  ProviderPlugin,
} from "./types.js";

const mockedLogger = vi.hoisted(() => ({
  info: vi.fn<(msg: string) => void>(),
  warn: vi.fn<(msg: string) => void>(),
  error: vi.fn<(msg: string) => void>(),
  debug: vi.fn<(msg: string) => void>(),
  child: vi.fn(() => mockedLogger),
}));

type PluginModelUsageEvent = Parameters<
  Parameters<NonNullable<OpenClawPluginServiceContext["modelUsage"]>["onEvent"]>[0]
>[0];

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => mockedLogger,
}));

import { STATE_DIR } from "../config/paths.js";
import {
  emitDiagnosticEvent,
  emitTrustedDiagnosticEvent,
  resetDiagnosticEventsForTest,
} from "../infra/diagnostic-events.js";
import {
  emitModelUsageEvent,
  resetCoreModelUsageEventsForTest,
} from "../infra/model-usage-events.js";
import { registerPluginHttpRoute } from "./http-registry.js";
import {
  pinActivePluginHttpRouteRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "./runtime.js";
import { startPluginServices } from "./services.js";

function createRegistry(
  services: OpenClawPluginService[],
  pluginId = "plugin:test",
  origin: PluginOrigin = "workspace",
  trustedOfficialInstall = false,
  providers: Array<{ pluginId?: string; provider: ProviderPlugin }> = [],
) {
  const registry = createEmptyPluginRegistry();
  registry.services = services.map((service) => ({
    pluginId,
    service,
    source: "test",
    origin,
    ...(trustedOfficialInstall ? { trustedOfficialInstall } : {}),
    rootDir: "/plugins/test-plugin",
  })) as typeof registry.services;
  registry.providers = providers.map((entry) => ({
    pluginId: entry.pluginId ?? pluginId,
    provider: entry.provider,
    source: "test",
    rootDir: "/plugins/test-plugin",
  }));
  return registry;
}

function createProvider(id: string, overrides: Partial<ProviderPlugin> = {}): ProviderPlugin {
  return {
    id,
    label: id,
    auth: [],
    ...overrides,
  };
}

function createServiceConfig() {
  return {} as Parameters<typeof startPluginServices>[0]["config"];
}

function createModelUsageServiceConfig() {
  return {
    diagnostics: {
      enabled: false,
    },
    plugins: {
      modelUsage: {
        enabled: true,
      },
    },
  } as Parameters<typeof startPluginServices>[0]["config"];
}

function expectServiceContext(
  ctx: OpenClawPluginServiceContext,
  config: Parameters<typeof startPluginServices>[0]["config"],
) {
  expect(ctx.config).toBe(config);
  expect(ctx.workspaceDir).toBe("/tmp/workspace");
  expect(ctx.stateDir).toBe(STATE_DIR);
  expectServiceLogger(ctx);
}

function expectServiceLogger(ctx: OpenClawPluginServiceContext) {
  expect(typeof ctx.logger.info).toBe("function");
  expect(typeof ctx.logger.warn).toBe("function");
  expect(typeof ctx.logger.error).toBe("function");
}

function expectServiceContexts(
  contexts: OpenClawPluginServiceContext[],
  config: Parameters<typeof startPluginServices>[0]["config"],
) {
  expect(contexts).not.toHaveLength(0);
  contexts.forEach((ctx) => {
    expectServiceContext(ctx, config);
  });
}

function expectServiceLifecycleState(params: {
  starts: string[];
  stops: string[];
  contexts: OpenClawPluginServiceContext[];
  config: Parameters<typeof startPluginServices>[0]["config"];
}) {
  expect(params.starts).toEqual(["a", "b", "c"]);
  expect(params.stops).toEqual(["c", "a"]);
  expect(params.contexts).toHaveLength(3);
  expectServiceContexts(params.contexts, params.config);
}

function requireLoggerErrorMessage(index = 0): string {
  const call = mockedLogger.error.mock.calls[index];
  if (!call) {
    throw new Error(`expected logger error call ${index}`);
  }
  return call[0];
}

async function startTrackingServices(params: {
  services: OpenClawPluginService[];
  config?: Parameters<typeof startPluginServices>[0]["config"];
  workspaceDir?: string;
  startupTrace?: Parameters<typeof startPluginServices>[0]["startupTrace"];
}) {
  return startPluginServices({
    registry: createRegistry(params.services),
    config: params.config ?? createServiceConfig(),
    ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
    ...(params.startupTrace ? { startupTrace: params.startupTrace } : {}),
  });
}

function createTrackingService(
  id: string,
  params: {
    starts?: string[];
    stops?: string[];
    contexts?: OpenClawPluginServiceContext[];
    failOnStart?: boolean;
    failOnStop?: boolean;
    stopSpy?: () => void;
  } = {},
): OpenClawPluginService {
  return {
    id,
    start: (ctx) => {
      if (params.failOnStart) {
        throw new Error("start failed");
      }
      params.starts?.push(id.at(-1) ?? id);
      params.contexts?.push(ctx);
    },
    stop: params.stopSpy
      ? () => {
          params.stopSpy?.();
        }
      : params.stops || params.failOnStop
        ? () => {
            if (params.failOnStop) {
              throw new Error("stop failed");
            }
            params.stops?.push(id.at(-1) ?? id);
          }
        : undefined,
  };
}

describe("startPluginServices", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDiagnosticEventsForTest();
    resetCoreModelUsageEventsForTest();
    resetPluginRuntimeStateForTest();
  });

  it("starts services and stops them in reverse order", async () => {
    const starts: string[] = [];
    const stops: string[] = [];
    const contexts: OpenClawPluginServiceContext[] = [];

    const config = createServiceConfig();
    const handle = await startTrackingServices({
      services: [
        createTrackingService("service-a", { starts, stops, contexts }),
        createTrackingService("service-b", { starts, contexts }),
        createTrackingService("service-c", { starts, stops, contexts }),
      ],
      config,
      workspaceDir: "/tmp/workspace",
    });
    await handle.stop();

    expectServiceLifecycleState({ starts, stops, contexts, config });
  });

  it("registers dynamic HTTP routes into the service registry scope", async () => {
    const serviceRegistry = createRegistry([
      {
        id: "route-service",
        start: () => {
          registerPluginHttpRoute({
            path: "/service-route",
            auth: "plugin",
            handler: vi.fn(),
          });
        },
      },
    ]);
    const pinnedRegistry = createEmptyPluginRegistry();

    setActivePluginRegistry(pinnedRegistry);
    pinActivePluginHttpRouteRegistry(pinnedRegistry);

    const handle = await startPluginServices({
      registry: serviceRegistry,
      config: createServiceConfig(),
    });

    expect(serviceRegistry.httpRoutes.map((route) => route.path)).toEqual(["/service-route"]);
    expect(pinnedRegistry.httpRoutes).toHaveLength(0);

    await handle.stop();
  });

  it("logs start/stop failures and continues", async () => {
    const stopOk = vi.fn();
    const stopThrows = vi.fn(() => {
      throw new Error("stop failed");
    });

    const handle = await startTrackingServices({
      services: [
        createTrackingService("service-start-fail", {
          failOnStart: true,
          stopSpy: vi.fn(),
        }),
        createTrackingService("service-ok", { stopSpy: stopOk }),
        createTrackingService("service-stop-fail", { stopSpy: stopThrows }),
      ],
    });

    await handle.stop();

    expect(mockedLogger.error.mock.calls).toEqual([
      [
        "plugin service failed (service-start-fail, plugin=plugin:test, root=/plugins/test-plugin): start failed",
      ],
    ]);
    expect(requireLoggerErrorMessage()).not.toContain("\n");
    expect(mockedLogger.warn.mock.calls).toEqual([
      ["plugin service stop failed (service-stop-fail): Error: stop failed"],
    ]);
    expect(stopOk).toHaveBeenCalledOnce();
    expect(stopThrows).toHaveBeenCalledOnce();
  });

  it("emits per-service startup trace spans and summary", async () => {
    const measured: string[] = [];
    const details: Array<{
      name: string;
      metrics: ReadonlyArray<readonly [string, number | string]>;
    }> = [];
    const startupTrace: NonNullable<Parameters<typeof startPluginServices>[0]["startupTrace"]> = {
      measure: async (name, run) => {
        measured.push(name);
        return await run();
      },
      detail: (name, metrics) => {
        details.push({ name, metrics });
      },
    };

    await startTrackingServices({
      services: [
        createTrackingService("service-a"),
        createTrackingService("service-fail", { failOnStart: true }),
      ],
      startupTrace,
    });

    expect(measured).toEqual([
      "sidecars.plugin-services.plugin~003Atest.service-a",
      "sidecars.plugin-services.plugin~003Atest.service-fail",
    ]);
    expect(details).toEqual([
      {
        name: "sidecars.plugin-services.summary",
        metrics: [
          ["serviceCount", 2],
          ["startedCount", 1],
          ["failedCount", 1],
        ],
      },
    ]);
  });

  it("passes a scoped startup trace through service context for owned subspans", async () => {
    const contexts: OpenClawPluginServiceContext[] = [];
    const measured: string[] = [];
    const details: Array<{
      name: string;
      metrics: ReadonlyArray<readonly [string, number | string]>;
    }> = [];
    const startupTrace: NonNullable<Parameters<typeof startPluginServices>[0]["startupTrace"]> = {
      measure: async (name, run) => {
        measured.push(name);
        return await run();
      },
      detail: (name, metrics) => {
        details.push({ name, metrics });
      },
    };

    await startTrackingServices({
      services: [
        {
          id: "service-a",
          start: async (ctx) => {
            contexts.push(ctx);
            ctx.startupTrace?.detail?.("probe.result", [["healthyCount", 1]]);
            await ctx.startupTrace?.measure("config:resolve", async () => {});
          },
        },
      ],
      startupTrace,
    });

    expect(contexts[0]?.startupTrace).not.toBe(startupTrace);
    expect(measured).toEqual([
      "sidecars.plugin-services.plugin~003Atest.service-a",
      "sidecars.plugin-services.plugin~003Atest.service-a.config~003Aresolve",
    ]);
    expect(details).toEqual([
      {
        name: "sidecars.plugin-services.plugin~003Atest.service-a.probe.result",
        metrics: [["healthyCount", 1]],
      },
      {
        name: "sidecars.plugin-services.summary",
        metrics: [
          ["serviceCount", 1],
          ["startedCount", 1],
          ["failedCount", 0],
        ],
      },
    ]);
  });

  it("keeps distinct service trace ownership keys non-colliding", async () => {
    const measured: string[] = [];
    const startupTrace: NonNullable<Parameters<typeof startPluginServices>[0]["startupTrace"]> = {
      measure: async (name, run) => {
        measured.push(name);
        return await run();
      },
    };

    await startPluginServices({
      registry: createRegistry(
        [createTrackingService("service:a"), createTrackingService("service_a")],
        "plugin:test",
      ),
      config: createServiceConfig(),
      startupTrace,
    });

    expect(measured).toEqual([
      "sidecars.plugin-services.plugin~003Atest.service~003Aa",
      "sidecars.plugin-services.plugin~003Atest.service_a",
    ]);
    expect(new Set(measured).size).toBe(measured.length);
  });

  it("omits model usage events from plugin services until enabled", async () => {
    const contexts: OpenClawPluginServiceContext[] = [];
    await startPluginServices({
      registry: createRegistry([createTrackingService("usage-reader", { contexts })]),
      config: createServiceConfig(),
    });

    expect(contexts[0]?.modelUsage).toBeUndefined();
  });

  it("exposes matching-provider usage when enabled without diagnostics", async () => {
    const seen: PluginModelUsageEvent[] = [];
    let unsubscribe: (() => void) | undefined;
    const config = createModelUsageServiceConfig();
    const usageService: OpenClawPluginService = {
      id: "usage-reader",
      start: (ctx) => {
        expect(ctx.modelUsage?.onEvent).toBeTypeOf("function");
        if (!ctx.modelUsage) {
          throw new Error("expected model usage subscription");
        }
        unsubscribe = ctx.modelUsage.onEvent((event) => {
          seen.push(event);
        });
      },
      stop: () => unsubscribe?.(),
    };
    const handle = await startPluginServices({
      registry: createRegistry([usageService], "usage-plugin", "workspace", false, [
        { provider: createProvider("anthropic") },
        { provider: createProvider("OpenAI") },
        { pluginId: "other-plugin", provider: createProvider("openai") },
      ]),
      config,
    });

    emitDiagnosticEvent({
      type: "model.usage",
      sessionKey: "ignored",
      usage: { total: 1 },
    });
    emitTrustedDiagnosticEvent({
      type: "model.usage",
      sessionKey: "forged",
      usage: { total: 1 },
    });
    emitModelUsageEvent(
      { diagnostics: { enabled: false } },
      {
        sessionKey: "not-enabled",
        usage: { total: 1 },
      },
    );
    emitModelUsageEvent(
      { diagnostics: { enabled: false }, plugins: { modelUsage: {} } },
      {
        sessionKey: "still-not-enabled",
        usage: { total: 1 },
      },
    );
    emitModelUsageEvent(config, {
      sessionKey: "colliding-provider",
      provider: "openai",
      usage: { total: 1 },
    });
    emitModelUsageEvent(config, {
      sessionKey: "agent:main:slack:channel:c1",
      sessionId: "session-1",
      channel: "slack",
      agentId: "main",
      provider: "anthropic",
      model: "gpt-5.5",
      usage: {
        input: 10,
        output: 5,
        cacheRead: 2,
        cacheWrite: 1,
        promptTokens: 13,
        total: 18,
      },
      lastCallUsage: {
        input: 4,
        output: 5,
        cacheRead: 2,
        cacheWrite: 1,
        total: 12,
      },
      context: {
        limit: 100,
        used: 13,
      },
      costUsd: 0.00042,
      durationMs: 123,
    });

    expect(seen).toEqual([
      {
        timestampMs: expect.any(Number),
        sequence: expect.any(Number),
        sessionKey: "agent:main:slack:channel:c1",
        sessionId: "session-1",
        channel: "slack",
        agentId: "main",
        provider: "anthropic",
        model: "gpt-5.5",
        usage: {
          input: 10,
          output: 5,
          cacheRead: 2,
          cacheWrite: 1,
          promptTokens: 13,
          total: 18,
        },
        lastCallUsage: {
          input: 4,
          output: 5,
          cacheRead: 2,
          cacheWrite: 1,
          total: 12,
        },
        context: {
          limit: 100,
          used: 13,
        },
        costUsd: 0.00042,
        durationMs: 123,
      },
    ]);

    await handle.stop();
    emitModelUsageEvent(config, {
      sessionKey: "after-stop",
      usage: { total: 1 },
    });
    expect(seen).toHaveLength(1);
  });

  it("grants internal diagnostics only to trusted diagnostics exporter services", async () => {
    const contexts: OpenClawPluginServiceContext[] = [];
    const diagnosticsService = createTrackingService("diagnostics-otel", { contexts });
    await startPluginServices({
      registry: createRegistry([diagnosticsService], "diagnostics-otel", "bundled"),
      config: createServiceConfig(),
    });

    expect(contexts[0]?.internalDiagnostics?.onEvent).toBeTypeOf("function");
    expect(contexts[0]?.internalDiagnostics?.emit).toBeTypeOf("function");

    const prometheusContexts: OpenClawPluginServiceContext[] = [];
    const prometheusService = createTrackingService("diagnostics-prometheus", {
      contexts: prometheusContexts,
    });
    await startPluginServices({
      registry: createRegistry([prometheusService], "diagnostics-prometheus", "bundled"),
      config: createServiceConfig(),
    });

    expect(prometheusContexts[0]?.internalDiagnostics?.onEvent).toBeTypeOf("function");
    expect(prometheusContexts[0]?.internalDiagnostics?.emit).toBeTypeOf("function");

    const officialDiagnosticsOtelContexts: OpenClawPluginServiceContext[] = [];
    const officialDiagnosticsOtelService = createTrackingService("diagnostics-otel", {
      contexts: officialDiagnosticsOtelContexts,
    });
    await startPluginServices({
      registry: createRegistry(
        [officialDiagnosticsOtelService],
        "diagnostics-otel",
        "config",
        true,
      ),
      config: createServiceConfig(),
    });

    expect(officialDiagnosticsOtelContexts[0]?.internalDiagnostics?.onEvent).toBeTypeOf("function");
    expect(officialDiagnosticsOtelContexts[0]?.internalDiagnostics?.emit).toBeTypeOf("function");

    const officialInstallContexts: OpenClawPluginServiceContext[] = [];
    const officialInstallService = createTrackingService("diagnostics-prometheus", {
      contexts: officialInstallContexts,
    });
    await startPluginServices({
      registry: createRegistry([officialInstallService], "diagnostics-prometheus", "global", true),
      config: createServiceConfig(),
    });

    expect(officialInstallContexts[0]?.internalDiagnostics?.onEvent).toBeTypeOf("function");
    expect(officialInstallContexts[0]?.internalDiagnostics?.emit).toBeTypeOf("function");

    const untrustedContexts: OpenClawPluginServiceContext[] = [];
    const untrustedService = createTrackingService("diagnostics-otel", {
      contexts: untrustedContexts,
    });
    await startPluginServices({
      registry: createRegistry([untrustedService], "diagnostics-otel", "workspace"),
      config: createServiceConfig(),
    });

    expect(untrustedContexts[0]?.internalDiagnostics).toBeUndefined();

    const spoofedContexts: OpenClawPluginServiceContext[] = [];
    const spoofedService = createTrackingService("diagnostics-prometheus", {
      contexts: spoofedContexts,
    });
    await startPluginServices({
      registry: createRegistry([spoofedService], "not-diagnostics-prometheus", "global", true),
      config: createServiceConfig(),
    });

    expect(spoofedContexts[0]?.internalDiagnostics).toBeUndefined();
  });
});
