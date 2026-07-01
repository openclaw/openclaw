/** Starts, stops, and inspects plugin service registrations. */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { STATE_DIR } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  emitTrustedDiagnosticEventWithPrivateData,
  onTrustedInternalDiagnosticEvent,
  type DiagnosticEventPayload,
} from "../infra/diagnostic-events.js";
import {
  isModelUsagePluginEventsEnabled,
  onCoreModelUsageEvent,
} from "../infra/model-usage-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { withPluginHttpRouteRegistry } from "./http-registry.js";
import type { PluginServiceRegistration } from "./registry-types.js";
import type { PluginRegistry } from "./registry.js";
import { encodeStartupTraceSegment } from "./startup-trace-segment.js";
import type { OpenClawPluginServiceContext, PluginLogger } from "./types.js";

const log = createSubsystemLogger("plugins");
type DiagnosticUsageEvent = Extract<DiagnosticEventPayload, { type: "model.usage" }>;
type PluginModelUsage = NonNullable<OpenClawPluginServiceContext["modelUsage"]>;
type PluginModelUsageEvent = Parameters<Parameters<PluginModelUsage["onEvent"]>[0]>[0];

function createPluginLogger(): PluginLogger {
  return {
    info: (msg) => log.info(msg),
    warn: (msg) => log.warn(msg),
    error: (msg) => log.error(msg),
    debug: (msg) => log.debug(msg),
  };
}

function toPluginModelUsageEvent({
  ts: timestampMs,
  seq: sequence,
  type: _type,
  trace: _trace,
  usage,
  lastCallUsage,
  context,
  ...event
}: DiagnosticUsageEvent): PluginModelUsageEvent {
  return {
    timestampMs,
    sequence,
    ...event,
    usage: { ...usage },
    ...(lastCallUsage !== undefined ? { lastCallUsage: { ...lastCallUsage } } : {}),
    ...(context !== undefined ? { context: { ...context } } : {}),
  };
}

function createModelUsageProviderIds(
  registry: PluginRegistry,
  pluginId: string,
): ReadonlySet<string> {
  const owners = new Map<string, string | null>();
  for (const entry of registry.providers) {
    const providerId = normalizeProviderId(entry.provider.id);
    if (!providerId) {
      continue;
    }
    const owner = owners.get(providerId);
    owners.set(providerId, owner === undefined || owner === entry.pluginId ? entry.pluginId : null);
  }
  const providerIds = new Set<string>();
  for (const [providerId, owner] of owners) {
    if (owner === pluginId) {
      providerIds.add(providerId);
    }
  }
  return providerIds;
}

function createServiceContext(params: {
  config: OpenClawConfig;
  registry: PluginRegistry;
  startupTrace?: PluginServiceStartupTrace;
  workspaceDir?: string;
  service: PluginServiceRegistration;
}): OpenClawPluginServiceContext {
  const isDiagnosticsExporter =
    params.service?.pluginId === params.service?.service.id &&
    (params.service?.service.id === "diagnostics-otel" ||
      params.service?.service.id === "diagnostics-prometheus");
  const grantsInternalDiagnostics =
    isDiagnosticsExporter &&
    (params.service?.origin === "bundled" || params.service?.trustedOfficialInstall === true);
  const modelUsageProviderIds = createModelUsageProviderIds(
    params.registry,
    params.service.pluginId,
  );

  return {
    config: params.config,
    workspaceDir: params.workspaceDir,
    stateDir: STATE_DIR,
    logger: createPluginLogger(),
    ...(isModelUsagePluginEventsEnabled(params.config)
      ? {
          modelUsage: {
            onEvent: (listener) =>
              onCoreModelUsageEvent((event) => {
                if (!modelUsageProviderIds.has(normalizeProviderId(event.provider ?? ""))) {
                  return;
                }
                listener(toPluginModelUsageEvent(event));
              }),
          },
        }
      : {}),
    ...(params.startupTrace
      ? {
          startupTrace: createScopedPluginServiceStartupTrace(
            params.startupTrace,
            createPluginServiceTraceName(params.service),
          ),
        }
      : {}),
    ...(grantsInternalDiagnostics
      ? {
          internalDiagnostics: {
            emit: emitTrustedDiagnosticEventWithPrivateData,
            onEvent: onTrustedInternalDiagnosticEvent,
          },
        }
      : {}),
  };
}

function createPluginServiceTraceName(entry: PluginServiceRegistration): string {
  return `sidecars.plugin-services.${encodeStartupTraceSegment(entry.pluginId)}.${encodeStartupTraceSegment(entry.service.id)}`;
}

function createScopedPluginServiceStartupTrace(
  startupTrace: PluginServiceStartupTrace,
  prefix: string,
): PluginServiceStartupTrace {
  const scopeName = (name: string) =>
    `${prefix}.${name
      .split(".")
      .map((segment) => encodeStartupTraceSegment(segment))
      .join(".")}`;
  return {
    measure: (name, run) => startupTrace.measure(scopeName(name), run),
    ...(startupTrace.detail
      ? {
          detail: (name, metrics) => startupTrace.detail?.(scopeName(name), metrics),
        }
      : {}),
  };
}

export type PluginServicesHandle = {
  stop: () => Promise<void>;
};

type PluginServiceStartupTrace = {
  detail?: (name: string, metrics: ReadonlyArray<readonly [string, number | string]>) => void;
  measure: <T>(name: string, run: () => T | Promise<T>) => Promise<T>;
};

export async function startPluginServices(params: {
  registry: PluginRegistry;
  config: OpenClawConfig;
  workspaceDir?: string;
  startupTrace?: PluginServiceStartupTrace;
}): Promise<PluginServicesHandle> {
  const running: Array<{
    id: string;
    stop?: () => void | Promise<void>;
  }> = [];
  let failedCount = 0;
  for (const entry of params.registry.services) {
    const service = entry.service;
    const traceName = createPluginServiceTraceName(entry);
    const serviceContext = createServiceContext({
      config: params.config,
      registry: params.registry,
      startupTrace: params.startupTrace,
      workspaceDir: params.workspaceDir,
      service: entry,
    });
    try {
      const startService = () =>
        withPluginHttpRouteRegistry(params.registry, () => service.start(serviceContext));
      if (params.startupTrace) {
        await params.startupTrace.measure(traceName, startService);
      } else {
        await startService();
      }
      running.push({
        id: service.id,
        stop: service.stop ? () => service.stop?.(serviceContext) : undefined,
      });
    } catch (err) {
      failedCount += 1;
      const error = err as Error;
      log.error(
        `plugin service failed (${service.id}, plugin=${entry.pluginId}, root=${entry.rootDir ?? "unknown"}): ${error?.message ?? String(err)}`,
      );
    }
  }
  params.startupTrace?.detail?.("sidecars.plugin-services.summary", [
    ["serviceCount", params.registry.services.length],
    ["startedCount", running.length],
    ["failedCount", failedCount],
  ]);

  return {
    stop: async () => {
      for (const entry of running.toReversed()) {
        if (!entry.stop) {
          continue;
        }
        try {
          await withPluginHttpRouteRegistry(params.registry, () => entry.stop?.());
        } catch (err) {
          log.warn(`plugin service stop failed (${entry.id}): ${String(err)}`);
        }
      }
    },
  };
}
