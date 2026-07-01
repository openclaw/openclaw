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
  service: PreparedPluginServiceRegistration;
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

type PreparedPluginServiceRegistration = Omit<PluginServiceRegistration, "service"> & {
  service: OpenClawPluginService;
  serviceId: string;
  start: OpenClawPluginService["start"];
};

type PluginServiceRegistrationReadResult =
  | { ok: true; registration: PreparedPluginServiceRegistration }
  | {
      ok: false;
      error: unknown;
      pluginId: string;
      rootDir?: string;
      serviceId: string;
    };

function readStringField(
  read: () => unknown,
  fallback: string,
):
  | { ok: true; usedFallback: boolean; value: string }
  | { ok: false; error: unknown; value: string } {
  try {
    const value = read();
    return typeof value === "string" && value.length > 0
      ? { ok: true, usedFallback: false, value }
      : { ok: true, usedFallback: true, value: fallback };
  } catch (error) {
    return { ok: false, error, value: fallback };
  }
}

function formatServiceError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readOptionalField<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

function readPluginServiceRegistration(
  entry: PluginServiceRegistration,
): PluginServiceRegistrationReadResult {
  const pluginId = readStringField(() => entry.pluginId, "unknown-plugin").value;
  const rootDirResult = readStringField(() => entry.rootDir, "unknown");
  const rootDir = rootDirResult.value;
  let service: OpenClawPluginService;
  try {
    service = entry.service;
  } catch (error) {
    return { ok: false, error, pluginId, rootDir, serviceId: "unknown-service" };
  }

  const serviceIdResult = readStringField(() => service.id, "unknown-service");
  if (!serviceIdResult.ok || serviceIdResult.usedFallback) {
    return {
      ok: false,
      error: serviceIdResult.ok
        ? new Error("service registration missing id")
        : serviceIdResult.error,
      pluginId,
      rootDir,
      serviceId: serviceIdResult.value,
    };
  }

  let start: OpenClawPluginService["start"];
  try {
    start = service.start;
  } catch (error) {
    return { ok: false, error, pluginId, rootDir, serviceId: serviceIdResult.value };
  }
  if (typeof start !== "function") {
    return {
      ok: false,
      error: new Error("service registration missing start handler"),
      pluginId,
      rootDir,
      serviceId: serviceIdResult.value,
    };
  }

  return {
    ok: true,
    registration: {
      pluginId,
      pluginName: readStringField(() => entry.pluginName, pluginId).value,
      service,
      serviceId: serviceIdResult.value,
      start: (ctx) => start.call(service, ctx),
      source: readStringField(() => entry.source, "unknown").value,
      origin: readOptionalField(() => entry.origin) ?? "workspace",
      trustedOfficialInstall: readOptionalField(() => entry.trustedOfficialInstall),
      rootDir,
    },
  };
}

function createPluginServiceTraceName(entry: PreparedPluginServiceRegistration): string {
  return `sidecars.plugin-services.${encodeStartupTraceSegment(entry.pluginId)}.${encodeStartupTraceSegment(entry.serviceId)}`;
}

function readPluginServiceStop(
  entry: PreparedPluginServiceRegistration,
): { ok: true; hasStop: boolean } | { ok: false; error: unknown } {
  try {
    const stop = entry.service.stop;
    if (stop == null) {
      return { ok: true, hasStop: false };
    }
    return typeof stop === "function"
      ? { ok: true, hasStop: true }
      : { ok: false, error: new Error("service stop handler is not a function") };
  } catch (error) {
    return { ok: false, error };
  }
}

function createPluginServiceStop(
  entry: PreparedPluginServiceRegistration,
  serviceContext: OpenClawPluginServiceContext,
): () => void | Promise<void> {
  return () => {
    const stop = entry.service.stop;
    if (stop == null) {
      return;
    }
    if (typeof stop !== "function") {
      throw new Error("service stop handler is not a function");
    }
    return stop.call(entry.service, serviceContext);
  };
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
  for (const rawEntry of params.registry.services) {
    const readResult = readPluginServiceRegistration(rawEntry);
    if (!readResult.ok) {
      failedCount += 1;
      log.error(
        `plugin service failed (${readResult.serviceId}, plugin=${readResult.pluginId}, root=${readResult.rootDir ?? "unknown"}): ${formatServiceError(readResult.error)}`,
      );
      continue;
    }
    const entry = readResult.registration;
    const traceName = createPluginServiceTraceName(entry);
    const serviceContext = createServiceContext({
      config: params.config,
      startupTrace: params.startupTrace,
      workspaceDir: params.workspaceDir,
      service: entry,
    });
    try {
      const startService = () =>
        withPluginHttpRouteRegistry(params.registry, () => entry.start(serviceContext));
      if (params.startupTrace) {
        await params.startupTrace.measure(traceName, startService);
      } else {
        await startService();
      }
      const stopReadResult = readPluginServiceStop(entry);
      if (!stopReadResult.ok) {
        failedCount += 1;
        log.error(
          `plugin service failed (${entry.serviceId}, plugin=${entry.pluginId}, root=${entry.rootDir ?? "unknown"}): ${formatServiceError(stopReadResult.error)}`,
        );
        continue;
      }
      running.push({
        id: entry.serviceId,
        stop: stopReadResult.hasStop ? createPluginServiceStop(entry, serviceContext) : undefined,
      });
    } catch (err) {
      failedCount += 1;
      log.error(
        `plugin service failed (${entry.serviceId}, plugin=${entry.pluginId}, root=${entry.rootDir ?? "unknown"}): ${formatServiceError(err)}`,
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
