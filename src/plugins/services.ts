/** Starts, stops, and inspects plugin service registrations. */
import { STATE_DIR } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  emitTrustedDiagnosticEventWithPrivateData,
  onTrustedInternalDiagnosticEvent,
} from "../infra/diagnostic-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { withPluginHttpRouteRegistry } from "./http-registry.js";
import type { PluginServiceRegistration } from "./registry-types.js";
import type { PluginRegistry } from "./registry.js";
import { encodeStartupTraceSegment } from "./startup-trace-segment.js";
import type { OpenClawPluginService, OpenClawPluginServiceContext, PluginLogger } from "./types.js";

const log = createSubsystemLogger("plugins");
function createPluginLogger(): PluginLogger {
  return {
    info: (msg) => log.info(msg),
    warn: (msg) => log.warn(msg),
    error: (msg) => log.error(msg),
    debug: (msg) => log.debug(msg),
  };
}

function createServiceContext(params: {
  config: OpenClawConfig;
  startupTrace?: PluginServiceStartupTrace;
  workspaceDir?: string;
  service: ReadablePluginServiceRegistration;
}): OpenClawPluginServiceContext {
  const isDiagnosticsExporter =
    params.service.pluginId === params.service.serviceId &&
    (params.service.serviceId === "diagnostics-otel" ||
      params.service.serviceId === "diagnostics-prometheus");
  const grantsInternalDiagnostics =
    isDiagnosticsExporter &&
    (params.service.origin === "bundled" || params.service.trustedOfficialInstall === true);

  return {
    config: params.config,
    workspaceDir: params.workspaceDir,
    stateDir: STATE_DIR,
    logger: createPluginLogger(),
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

type ReadablePluginServiceRegistration = {
  readonly pluginId: string;
  readonly serviceId: string;
  readonly pluginService: OpenClawPluginService;
  readonly start: OpenClawPluginService["start"];
  readonly origin: PluginServiceRegistration["origin"];
  readonly trustedOfficialInstall?: boolean;
  readonly rootDir?: string;
};

type PluginServiceRegistrationReadResult =
  | { readonly ok: true; readonly entry: ReadablePluginServiceRegistration }
  | { readonly ok: false; readonly error: unknown };

function createPluginServiceTraceName(entry: ReadablePluginServiceRegistration): string {
  return `sidecars.plugin-services.${encodeStartupTraceSegment(entry.pluginId)}.${encodeStartupTraceSegment(entry.serviceId)}`;
}

function readPluginServiceRegistration(
  entry: PluginServiceRegistration,
): PluginServiceRegistrationReadResult {
  try {
    const pluginId = entry.pluginId;
    const service = entry.service;
    return {
      ok: true,
      entry: {
        pluginId,
        serviceId: service.id,
        pluginService: service,
        start: service.start,
        origin: entry.origin,
        ...(entry.trustedOfficialInstall === undefined
          ? {}
          : { trustedOfficialInstall: entry.trustedOfficialInstall }),
        ...(entry.rootDir === undefined ? {} : { rootDir: entry.rootDir }),
      },
    };
  } catch (error) {
    return { ok: false, error };
  }
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
    const readable = readPluginServiceRegistration(entry);
    if (!readable.ok) {
      failedCount += 1;
      log.error(`plugin service registration unreadable: ${String(readable.error)}`);
      continue;
    }
    const service = readable.entry;
    const traceName = createPluginServiceTraceName(service);
    const serviceContext = createServiceContext({
      config: params.config,
      startupTrace: params.startupTrace,
      workspaceDir: params.workspaceDir,
      service,
    });
    try {
      const startService = () =>
        withPluginHttpRouteRegistry(params.registry, () =>
          service.start.call(service.pluginService, serviceContext),
        );
      if (params.startupTrace) {
        await params.startupTrace.measure(traceName, startService);
      } else {
        await startService();
      }
      const stopService = service.pluginService.stop;
      running.push({
        id: service.serviceId,
        stop: stopService
          ? () => stopService.call(service.pluginService, serviceContext)
          : undefined,
      });
    } catch (err) {
      failedCount += 1;
      const error = err as Error;
      log.error(
        `plugin service failed (${service.serviceId}, plugin=${service.pluginId}, root=${service.rootDir ?? "unknown"}): ${error?.message ?? String(err)}`,
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
