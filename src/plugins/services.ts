import { STATE_DIR } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getGatewayProcessInstanceId } from "../gateway/process-instance.js";
import type { GatewayPluginEventBroadcastFn } from "../gateway/server-broadcast-types.js";
import {
  emitTrustedDiagnosticEventWithPrivateData,
  onTrustedInternalDiagnosticEvent,
  waitForDiagnosticEventsDrained,
} from "../infra/diagnostic-events.js";
import { markTrustedOtelDiagnosticListener } from "../infra/diagnostic-otel-listener-provenance.js";
import { registerDiagnosticTracePropagationBridge } from "../infra/diagnostic-trace-propagation.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  recordDiagnosticExporterHealth,
  type DiagnosticExporterHealthUpdate,
} from "../logging/diagnostic-stability.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { trackAsyncWork } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveRuntimeServiceBuildId } from "../version.js";
import {
  createPluginRuntimeCapabilityLease,
  type PluginRuntimeCapabilityLease,
} from "./capability-lease.js";
import { subscribePluginSessionsChanged } from "./gateway-events.js";
import { isPluginJsonValue, type PluginJsonValue } from "./host-hook-json.js";
import { withPluginHttpRouteRegistry } from "./http-registry.js";
import { getPluginInstance, runPluginCleanup } from "./plugin-instance-scope.js";
import { resolvePluginReturnPromise } from "./plugin-return-value.js";
import { getPluginRecordRegistry } from "./registry-lifecycle.js";
import type { PluginServiceRegistration } from "./registry-types.js";
import type { PluginRegistry } from "./registry.js";
import { createPluginServiceCronGetter, type PluginServiceCronHost } from "./service-cron.js";
import { createPluginServiceHealthReporter } from "./service-health.js";
import { encodeStartupTraceSegment } from "./startup-trace-segment.js";
import type { OpenClawPluginServiceContext } from "./types.js";

const log = createSubsystemLogger("plugins");
export const PLUGIN_SERVICE_REPLACEMENT_STOP_TIMEOUT_MS = 5_000;

class PluginServiceTimeoutError extends Error {}

type TrustedExporterInternalDiagnostics = NonNullable<
  OpenClawPluginServiceContext["internalDiagnostics"]
> & {
  reportExporterHealth: (update: DiagnosticExporterHealthUpdate) => void;
};

type PluginServiceStopResult = { errors: readonly unknown[] };

export type PluginServicesHandle = {
  reload: (config: OpenClawConfig, serviceIds: ReadonlySet<string>) => Promise<void>;
  stop: (options?: {
    strict: true;
    deadlineAtMs?: number;
    pluginIds?: ReadonlySet<string>;
  }) => Promise<void | PluginServiceStopResult>;
};

type OwnedPluginService = {
  owner: PluginServicesOwner;
  id: string;
  pluginId: string;
  registration: PluginServiceRegistration;
  registry: PluginRegistry;
  diagnosticsExporter: boolean;
  stop?: () => unknown;
  startup?: Promise<void>;
  stopping?: Promise<unknown>;
  reloading?: Promise<void>;
  cleaned: boolean;
  cleanupErrors: unknown[];
  cleanupReporting?: Promise<unknown>;
  stopRequested: boolean;
  health: NonNullable<OpenClawPluginServiceContext["serviceHealth"]>;
  lease: PluginRuntimeCapabilityLease;
};

type PluginServicesOwner = {
  services: OwnedPluginService[];
  registrations: Set<PluginServiceRegistration>;
  stopped: Set<PluginServiceRegistration>;
  closed: boolean;
};
const serviceOwners = new WeakMap<PluginServicesHandle, PluginServicesOwner>();

export async function startPluginServices(
  params: {
    registry: PluginRegistry;
    config: OpenClawConfig;
    workspaceDir?: string;
    startupTrace?: NonNullable<OpenClawPluginServiceContext["startupTrace"]>;
    broadcastPluginEvent?: GatewayPluginEventBroadcastFn;
    getCronService?: () => PluginServiceCronHost | null | undefined;
    oneShotStopTimeouts?: { eventDrainMs: number; serviceStopMs: number };
    previous?: PluginServicesHandle | null;
  } & (
    | { throwOnStartError: true; onHandle: (handle: PluginServicesHandle) => void }
    | { throwOnStartError?: false; onHandle?: (handle: PluginServicesHandle) => void }
  ),
): Promise<PluginServicesHandle> {
  // Failed starts still own their cleanup and remain selectable for a later retry.
  const ownedServices: OwnedPluginService[] = [];
  const owner: PluginServicesOwner = {
    services: ownedServices,
    registrations: new Set(params.registry.services),
    stopped: new Set(),
    closed: false,
  };
  const previous = params.previous && serviceOwners.get(params.previous);
  if (previous) {
    for (const registration of owner.registrations) {
      previous.registrations.delete(registration);
      const entry = previous.services.find((service) => service.registration === registration);
      if (!entry) {
        continue;
      }
      previous.services.splice(previous.services.indexOf(entry), 1);
      // Explicitly stopped, fully cleaned registrations can start again in a new
      // generation. Failed attempts stay in the inventory until an explicit reload.
      if (previous.stopped.has(registration) && entry.cleaned && !entry.startup) {
        continue;
      }
      if (previous.stopped.has(registration)) {
        owner.stopped.add(registration);
      }
      entry.owner = owner;
      ownedServices.push(entry);
    }
  }
  const canStart = (registration: PluginServiceRegistration) =>
    !owner.closed && owner.registrations.has(registration) && !owner.stopped.has(registration);
  const runBeforeDeadline = async (
    run: () => unknown,
    deadline: number | undefined,
    label: string,
    serviceOwner?: string,
  ): Promise<unknown> => {
    const operation = Promise.resolve(run());
    if (deadline === undefined) {
      return operation;
    }
    const remaining = deadline - Date.now();
    const timeoutError = () =>
      new PluginServiceTimeoutError(
        `${label} timed out after ${Math.max(0, remaining)}ms${serviceOwner ? ` (${serviceOwner})` : ""}`,
      );
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        operation,
        remaining <= 0
          ? Promise.reject(timeoutError())
          : new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(timeoutError()), remaining);
              timer.unref?.();
            }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    return undefined;
  };
  const stopService = async (
    entry: OwnedPluginService,
    failures?: unknown[],
    deadline?: number,
    beforeStop?: Promise<unknown>,
  ) => {
    entry.stopRequested = true;
    const recordFailure = (error: unknown) =>
      failures?.push(
        deadline === undefined
          ? error
          : new Error(
              `plugin service stop failed (plugin=${entry.pluginId}, service=${entry.id}): ${
                error instanceof PluginServiceTimeoutError
                  ? error.message
                  : `rejected: ${formatErrorMessage(error)}`
              }`,
              { cause: error },
            ),
      );
    try {
      const invokeStop = () => {
        const record = entry.registry.plugins.find((candidate) => candidate.id === entry.pluginId);
        const registry = record ? getPluginRecordRegistry(entry.registry, record) : entry.registry;
        return withPluginHttpRouteRegistry(registry, () => entry.stop?.(), entry.lease);
      };
      const cleanup = () => {
        if (!entry.stopping) {
          try {
            // A caller can stop waiting, but raw startup must finish before the one final cleanup.
            const ready = beforeStop ? beforeStop.then(() => entry.startup) : entry.startup;
            const stopping = ready ? ready.then(invokeStop) : Promise.resolve(invokeStop());
            entry.stopping = stopping;
            // Completion follows the attempt across handoff, independently of an observer's deadline.
            void stopping.then(
              () => {
                entry.cleaned = entry.cleanupErrors.length === 0;
              },
              () => {},
            );
          } catch (error) {
            // Cache the exact rejection, including non-Error values thrown by plugin hooks.
            const failure = createDeferredCore();
            failure.reject(error);
            entry.stopping = failure.promise;
          }
        }
        const cleanupPromise = entry.stopping;
        // Track custody separately: an async wrapper can change a zero-budget deadline race.
        // The deadline path already reports the original cleanup rejection.
        void trackAsyncWork(() => cleanupPromise).catch(() => {});
        return cleanupPromise;
      };
      await runBeforeDeadline(
        cleanup,
        deadline,
        entry.startup ? "plugin service startup settlement" : "plugin service stop",
      );
      await entry.cleanupReporting;
      entry.cleanupErrors.forEach(recordFailure);
    } catch (err) {
      // Only this issued callback can record its rejection; host admission stays exceptional.
      if (entry.cleanupErrors.includes(err)) {
        await entry.cleanupReporting;
        entry.cleanupErrors.forEach(recordFailure);
        return;
      }
      // A startup observer timeout is not a failure reported by the still-running service.
      if (!entry.startup) {
        entry.health.reportFailure(err);
      }
      log.warn(`plugin service stop failed (${entry.id}): ${formatErrorMessage(err)}`);
      // Callback failures are recorded inside their admission; other host failures stay exceptional.
      if (!(err instanceof PluginServiceTimeoutError)) {
        throw err;
      }
      recordFailure(err);
    } finally {
      entry.lease.revoke();
    }
  };
  const stopServices = async (
    reversed: OwnedPluginService[],
    strict: boolean,
    failures: unknown[],
    deadline?: number,
  ) => {
    for (const entry of reversed) {
      entry.stopRequested = true;
    }
    const oneShotTimeouts = deadline === undefined ? params.oneShotStopTimeouts : undefined;
    // One-shot registries are already scoped; every cleanup follows the drain, without changing grants.
    const afterDrain = oneShotTimeouts
      ? reversed
      : reversed.filter((entry) => entry.diagnosticsExporter);
    const producers = oneShotTimeouts ? [] : reversed.filter((entry) => !entry.diagnosticsExporter);
    for (const entry of producers) {
      await stopService(entry, failures, deadline);
    }
    let exporterReady: Promise<unknown> | undefined;
    if (afterDrain.length > 0) {
      const owners = afterDrain
        .map((entry) => `plugin=${entry.pluginId}, service=${entry.id}`)
        .join("; ");
      // Final exporter cleanup follows actual producer cleanup, even after an observer times out.
      const draining = Promise.allSettled([
        ...afterDrain.map((entry) => entry.startup),
        ...producers.map((entry) => entry.stopping),
      ]).then(() =>
        runBeforeDeadline(
          waitForDiagnosticEventsDrained,
          oneShotTimeouts ? Date.now() + oneShotTimeouts.eventDrainMs : deadline,
          "plugin diagnostic event drain",
          owners,
        ),
      );
      // A bounded drain failure must not prevent the exporter's final stop from running.
      exporterReady = draining.catch(() => {});
      try {
        await runBeforeDeadline(() => draining, deadline, "plugin diagnostic event drain", owners);
      } catch (error) {
        if (!strict && !oneShotTimeouts) {
          throw error;
        }
        failures.push(error);
      }
    }
    // Fresh one-shot flush budgets start after drain; absolute replacement deadlines span all phases.
    const stopDeadline = oneShotTimeouts ? Date.now() + oneShotTimeouts.serviceStopMs : deadline;
    for (const entry of afterDrain) {
      await stopService(entry, failures, stopDeadline, exporterReady);
    }
  };
  let reloadTail = Promise.resolve();
  const handle: PluginServicesHandle = {
    reload: (config, serviceIds) => {
      const reloading = reloadTail.then(async () => {
        await startupSettled;
        if (owner.closed) {
          throw new Error("Plugin services are stopping");
        }
        const selected = ownedServices.filter((entry) => serviceIds.has(entry.id));
        if (selected.some((entry) => owner.stopped.has(entry.registration))) {
          throw new Error("Plugin services are stopping");
        }
        for (const entry of selected) {
          entry.reloading = reloading;
        }
        const failures: unknown[] = [];
        try {
          await stopServices(
            selected.toReversed(),
            true,
            failures,
            Date.now() + PLUGIN_SERVICE_REPLACEMENT_STOP_TIMEOUT_MS,
          );
          if (failures.length > 0) {
            throw new AggregateError(failures, "plugin service reload cleanup failed");
          }
          for (const entry of selected) {
            if (!canStart(entry.registration)) {
              continue;
            }
            if (!(await startService(entry.registration, config, failures))) {
              throw new AggregateError(failures, "plugin service reload startup failed");
            }
          }
        } finally {
          for (const entry of selected) {
            if (entry.reloading === reloading) {
              delete entry.reloading;
            }
          }
        }
      });
      reloadTail = reloading.catch(() => {});
      return reloading;
    },
    stop: (options) => {
      owner.closed ||= options?.pluginIds === undefined;
      for (const registration of owner.registrations) {
        if (!options?.pluginIds || options.pluginIds.has(registration.pluginId)) {
          owner.stopped.add(registration);
        }
      }
      // Stop retains its issued selection even if another handle takes the registrations.
      const selected = ownedServices.filter(
        (entry) => !options?.pluginIds || options.pluginIds.has(entry.pluginId),
      );
      for (const entry of selected) {
        entry.stopRequested = true;
      }
      const strict = options?.strict === true;
      const deadline = strict ? options.deadlineAtMs : undefined;
      return Promise.resolve().then(async () => {
        const failures: unknown[] = [];
        await stopServices(selected.toReversed(), strict, failures, deadline);
        if (strict && failures.length > 0) {
          throw new AggregateError(failures, "plugin service replacement cleanup failed");
        }
        return failures.length > 0 ? { errors: failures } : undefined;
      });
    },
  };
  serviceOwners.set(handle, owner);
  // The issued handle keeps retained services and failed cleanup even when startup rejects.
  params.onHandle?.(handle);

  const startService = async (
    entry: PluginServiceRegistration,
    config: OpenClawConfig,
    failures?: unknown[],
    candidate = false,
  ): Promise<boolean> => {
    const service = entry.service;
    const record = params.registry.plugins.find((plugin) => plugin.id === entry.pluginId);
    const instance = record && getPluginInstance(record);
    // Native service receivers retain their brands; registration owns their invocation scope.
    const runServiceCleanup = <T>(run: () => T): T =>
      instance ? instance.runCleanup(run) : runPluginCleanup(service, run);
    const traceName = `sidecars.plugin-services.${encodeStartupTraceSegment(entry.pluginId)}.${encodeStartupTraceSegment(entry.service.id)}`;
    const lease = createPluginRuntimeCapabilityLease("plugin service");
    const pluginId = entry.pluginId;
    const broadcast = params.broadcastPluginEvent;
    // The broadcaster owns delivery and sessions.changed scheduling. Without it,
    // omit this capability so plugins can detect absence and choose their fallback.
    const gatewayEvents: OpenClawPluginServiceContext["gatewayEvents"] = broadcast
      ? {
          emit: (event, payload: PluginJsonValue, opts) => {
            lease.assertActive("gateway event emitter");
            if (!/^[a-z][a-z0-9_-]*$/u.test(event)) {
              throw new Error(`invalid plugin gateway event name: ${event}`);
            }
            if (!isPluginJsonValue(payload)) {
              throw new Error("plugin gateway event payload must be bounded JSON");
            }
            if (
              opts?.scope !== "operator.read" &&
              opts?.scope !== "operator.write" &&
              opts?.scope !== "operator.admin"
            ) {
              throw new Error("plugin gateway event scope must be an operator scope");
            }
            broadcast(`plugin.${pluginId}.${event}`, payload, opts.scope);
          },
          onSessionsChanged: (handler) => {
            lease.assertActive("gateway event subscriber");
            return lease.retain(subscribePluginSessionsChanged(handler));
          },
        }
      : undefined;
    const { health, revoke } = createPluginServiceHealthReporter(entry);
    lease.retain(revoke);
    const { startupTrace, workspaceDir } = params;
    const getCron = params.getCronService
      ? createPluginServiceCronGetter({
          getCron: params.getCronService,
          lease,
          isStopping: () => ownedService.owner.closed || ownedService.stopRequested,
        })
      : undefined;
    const isDiagnosticsExporter =
      entry?.pluginId === entry?.service.id &&
      (entry?.service.id === "diagnostics-otel" || entry?.service.id === "diagnostics-prometheus");
    const isOtelExporter = isDiagnosticsExporter && entry.service.id === "diagnostics-otel";
    const grantsInternalDiagnostics =
      isDiagnosticsExporter &&
      (entry?.origin === "bundled" || entry?.trustedOfficialInstall === true);
    const internalDiagnostics: TrustedExporterInternalDiagnostics | undefined =
      grantsInternalDiagnostics
        ? {
            getRuntimeIdentity: () => {
              lease.assertActive("runtime diagnostic identity");
              const buildId = resolveRuntimeServiceBuildId();
              return {
                processInstanceId: getGatewayProcessInstanceId(),
                ...(buildId ? { buildId } : {}),
              };
            },
            emit: (event, privateData) => {
              lease.assertActive("internal diagnostic emitter");
              emitTrustedDiagnosticEventWithPrivateData(event, privateData);
            },
            onEvent: (listener, filter, options) => {
              lease.assertActive("internal diagnostic listener");
              const trustedListener = isOtelExporter
                ? markTrustedOtelDiagnosticListener(listener)
                : listener;
              return lease.retain(
                onTrustedInternalDiagnosticEvent(trustedListener, filter, options),
              );
            },
            registerTracePropagationBridge: (bridge) => {
              lease.assertActive("diagnostic trace propagation bridge");
              return lease.retain(registerDiagnosticTracePropagationBridge(bridge));
            },
            reportExporterHealth: (update) => {
              if (lease.isActive()) {
                recordDiagnosticExporterHealth(entry.service.id, update);
              }
            },
          }
        : undefined;

    const scopeTraceName = (name: string) =>
      `${traceName}.${name.split(".").map(encodeStartupTraceSegment).join(".")}`;
    const serviceContext: OpenClawPluginServiceContext = {
      config,
      workspaceDir,
      stateDir: STATE_DIR,
      logger: {
        info: (msg) => log.info(msg),
        warn: (msg) => log.warn(msg),
        error: (msg) => log.error(msg),
        debug: (msg) => log.debug(msg),
      },
      serviceHealth: health,
      ...(getCron ? { getCron } : {}),
      ...(gatewayEvents ? { gatewayEvents } : {}),
      ...(startupTrace
        ? {
            startupTrace: {
              measure: (name, run) => startupTrace.measure(scopeTraceName(name), run),
              ...(startupTrace.detail
                ? {
                    detail: (name, metrics) => startupTrace.detail?.(scopeTraceName(name), metrics),
                  }
                : {}),
            },
          }
        : {}),
      ...(internalDiagnostics ? { internalDiagnostics } : {}),
    };
    const recordCleanupFailure = (error: unknown) => {
      ownedService.cleanupErrors.push(error);
      health.reportFailure(error);
      log.warn(`plugin service stop failed (${service.id}): ${formatErrorMessage(error)}`);
    };
    const ownedService: OwnedPluginService = {
      owner,
      cleaned: false,
      cleanupErrors: [],
      id: service.id,
      pluginId: entry.pluginId,
      registration: entry,
      registry: params.registry,
      stopRequested: false,
      diagnosticsExporter: serviceContext.internalDiagnostics !== undefined,
      stop: service.stop
        ? () =>
            runServiceCleanup(() => {
              try {
                const result = service.stop?.(serviceContext);
                const completion = resolvePluginReturnPromise(result);
                if (!completion) {
                  return result;
                }
                // Keep the original completion for deadlines; join reporting only after settlement.
                ownedService.cleanupReporting = completion.catch(recordCleanupFailure);
                void ownedService.cleanupReporting.catch(() => {});
                return completion;
              } catch (error) {
                return recordCleanupFailure(error);
              }
            })
        : undefined,
      health,
      lease,
    };
    // Retry in place. A new registration is inserted before retained later declarations,
    // so transfer cannot reorder a dependency behind its already-running consumer.
    const existingIndex = ownedServices.findIndex((current) => current.registration === entry);
    if (existingIndex >= 0) {
      ownedServices[existingIndex] = ownedService;
    } else {
      const declarationIndex = params.registry.services.indexOf(entry);
      const following = ownedServices.findIndex(
        (current) => params.registry.services.indexOf(current.registration) > declarationIndex,
      );
      ownedServices.splice(following < 0 ? ownedServices.length : following, 0, ownedService);
    }
    try {
      const invokeStart = async () => {
        const settled = createDeferredCore();
        ownedService.startup = settled.promise;
        try {
          const start = () => service.start(serviceContext);
          await withPluginHttpRouteRegistry(
            params.registry,
            () => (instance ? instance.run(start) : start()),
            lease,
          );
        } finally {
          // Failed-start rollback waits on raw work, never on the rollback that follows it.
          ownedService.startup = undefined;
          settled.resolve();
        }
      };
      // Bound candidate observation only; raw completion remains owned by the entry.
      await runBeforeDeadline(
        () =>
          params.startupTrace ? params.startupTrace.measure(traceName, invokeStart) : invokeStart(),
        candidate ? Date.now() + PLUGIN_SERVICE_REPLACEMENT_STOP_TIMEOUT_MS : undefined,
        "plugin service startup",
        `${entry.pluginId}/${service.id}`,
      );
    } catch (err) {
      failures?.push(err);
      serviceContext.serviceHealth?.reportFailure(err);
      log.error(
        `plugin service failed (${service.id}, plugin=${entry.pluginId}, root=${entry.rootDir ?? "unknown"}): ${formatErrorMessage(err)}`,
      );
      if (candidate && err instanceof PluginServiceTimeoutError) {
        ownedService.owner.stopped.add(entry);
        ownedService.lease.revoke();
        // Detached cleanup already logs failures; its original entry.stopping
        // rejection remains owned by every later awaited stop.
        void stopService(ownedService).catch(() => {});
        return false;
      }
      // A failed start can already own resources; revoke events only after its cleanup runs.
      // Bound the cleanup: callers await startPluginServices without a timeout, so a hung
      // stop here would wedge plugin reload/startup forever.
      await stopService(
        ownedService,
        failures,
        Date.now() + PLUGIN_SERVICE_REPLACEMENT_STOP_TIMEOUT_MS,
      );
      return false;
    }
    return true;
  };
  let failedCount = 0;
  const startupSettled = (async () => {
    for (const entry of params.registry.services) {
      if (owner.closed) {
        break;
      }
      if (!canStart(entry)) {
        if (params.throwOnStartError && owner.stopped.has(entry)) {
          throw new Error(
            `Previous plugin service cleanup remains pending (${entry.pluginId}/${entry.service.id})`,
          );
        }
        continue;
      }
      const retained = ownedServices.find((service) => service.registration === entry);
      if (retained) {
        const reloading = retained.reloading;
        if (!reloading) {
          continue;
        }
        await reloading;
        if (!canStart(entry)) {
          continue;
        }
      }
      const failures: unknown[] = [];
      if (
        !(await startService(entry, params.config, failures, params.throwOnStartError === true))
      ) {
        failedCount += 1;
        if (params.throwOnStartError) {
          throw new AggregateError(failures, "plugin services failed to start");
        }
      }
    }
  })();
  await startupSettled;
  params.startupTrace?.detail?.("sidecars.plugin-services.summary", [
    ["serviceCount", params.registry.services.length],
    ["startedCount", ownedServices.length - failedCount],
    ["failedCount", failedCount],
  ]);
  return handle;
}
