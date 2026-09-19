import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { sleepWithAbort } from "../infra/backoff.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { createSubsystemLogger } from "../logging/subsystem.js";
import type { PluginHookGatewayCronService } from "../plugins/hook-gateway.types.js";
import { createHookRunner } from "../plugins/hooks.js";
import {
  PluginHostCleanupTimeoutError,
  withPluginHostCleanupTimeout,
} from "../plugins/host-hook-cleanup-timeout.js";
import type { PluginHostCleanupResult } from "../plugins/host-hook-cleanup.types.js";
import { withPluginHttpRouteRegistry } from "../plugins/http-registry.js";
import { PluginInstanceDrainTimeoutError } from "../plugins/plugin-instance-error.js";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import { disposePluginRegistryInstances } from "../plugins/runtime.js";
import {
  PLUGIN_SERVICE_REPLACEMENT_STOP_TIMEOUT_MS,
  getPluginServiceCleanupSettlement,
  type PluginServicesHandle,
} from "../plugins/services.js";
import type { GatewayPluginReloadStatus } from "./server-plugin-runtime-generation.js";

const PLUGIN_RELOAD_ADMITTED_WORK_TIMEOUT_MS = 60_000;

export class PluginAdmittedWorkTimeoutError extends Error {
  constructor(pluginIds: ReadonlySet<string>, cause: PluginHostCleanupTimeoutError) {
    const ids = [...pluginIds].join(", ");
    super(
      `plugin ${ids} admitted work did not settle within 60s; the previous plugin generation stays active. Retry \`openclaw plugins reload ${[...pluginIds].join(" ")}\` after that work finishes.`,
      { cause },
    );
  }
}

/** Owns resource handoff and rejected-registration cleanup for one reload transaction. */
export function createPluginReloadCleanup({
  previousRegistry,
  changedPluginIds,
  port,
  pluginWorkspaceDir,
  getCron,
  log,
  recordCleanup,
  retainRetirement,
}: {
  previousRegistry: PluginRegistry;
  changedPluginIds: Set<string>;
  port: number;
  pluginWorkspaceDir: string | undefined;
  getCron: () => PluginHookGatewayCronService;
  log: ReturnType<typeof createSubsystemLogger>;
  recordCleanup: (result: PluginHostCleanupResult) => void;
  retainRetirement: (retire: () => Promise<PluginHostCleanupResult>) => void;
}) {
  let pendingServiceCleanup: ReturnType<typeof getPluginServiceCleanupSettlement>;
  const attempt = async (errors: unknown[], run: () => void | Promise<void>) => {
    try {
      await run();
    } catch (error) {
      errors.push(error);
    }
  };
  const drainInstances = async (
    registry: PluginRegistry,
    pluginIds: ReadonlySet<string>,
    includeConsumers = true,
    isObservationCurrent?: () => boolean,
  ) => {
    for (const record of registry.plugins) {
      if (!pluginIds.has(record.id)) {
        continue;
      }
      if (isObservationCurrent?.() === false) {
        return;
      }
      const result = await withPluginHostCleanupTimeout(`plugin ${record.id} admitted work`, () =>
        getPluginInstance(record)?.drain({ includeConsumers }),
      );
      if (result?.errors.length) {
        throw new AggregateError(result.errors, `Plugin ${record.id} work did not drain`);
      }
    }
  };
  const drainWithDeadline = async (
    pluginIds: ReadonlySet<string>,
    signal: AbortSignal,
    reportStatus: (status: GatewayPluginReloadStatus) => void,
    phase: "reloading" | "recovering",
  ) => {
    const deadlineAtMs = Date.now() + PLUGIN_RELOAD_ADMITTED_WORK_TIMEOUT_MS;
    reportStatus({
      phase,
      pluginIds: [...changedPluginIds],
      deadlineAtMs,
      reason:
        phase === "recovering"
          ? "Waiting for cleanup and admitted work before restoring the previous plugin runtime."
          : `Waiting for admitted work of plugin ${[...pluginIds].join(", ")} before replacing it.`,
    });
    let backoffMs = 1_000;
    for (;;) {
      signal.throwIfAborted();
      let observing = true;
      try {
        await withPluginHostCleanupTimeout(
          phase === "recovering"
            ? "previous plugin recovery drain"
            : "previous plugin admitted work",
          async () => {
            if (phase === "recovering") {
              await pendingServiceCleanup?.settled;
            }
            await drainInstances(
              previousRegistry,
              pluginIds,
              phase === "recovering",
              phase === "reloading" ? () => observing : undefined,
            );
          },
          Math.max(0, Math.min(5_000, deadlineAtMs - Date.now())),
        ).finally(() => {
          // Late settlement must not quiesce another instance after rollback resumes it.
          observing = false;
        });
        return;
      } catch (error) {
        if (!(error instanceof PluginHostCleanupTimeoutError)) {
          throw error;
        }
        const remainingMs = deadlineAtMs - Date.now();
        if (remainingMs <= 0) {
          if (phase === "reloading") {
            throw error;
          }
          throw new Error("Previous plugin work did not settle before the recovery deadline", {
            cause: error,
          });
        }
        // Retry only settlement observation; never repeat resource cleanup
        // or acquire a replacement while the previous writer still owns it.
        await sleepWithAbort(Math.min(backoffMs, remainingMs), signal);
        backoffMs = Math.min(backoffMs * 2, 4_000);
      }
    }
  };
  const disposeInstances = async (registry: PluginRegistry, pluginIds: ReadonlySet<string>) => {
    const failures: unknown[] = [];
    for (const record of registry.plugins) {
      if (!pluginIds.has(record.id)) {
        continue;
      }
      await attempt(failures, async () => {
        const errors = await withPluginHostCleanupTimeout(
          `plugin ${record.id} resources`,
          async () => {
            const result = await getPluginInstance(record)?.dispose();
            return collectResourceFailures(result?.errors ?? []);
          },
        );
        failures.push(...errors);
      });
    }
    if (failures.length) {
      throw new AggregateError(failures, "Plugin resource cleanup failed");
    }
  };
  const runLifecycleHooks = async (
    registry: PluginRegistry,
    start: boolean,
    config: OpenClawConfig,
    pluginIds: ReadonlySet<string> = changedPluginIds,
  ) => {
    const hooks = createHookRunner(
      {
        ...registry,
        typedHooks: registry.typedHooks.filter((hook) => pluginIds.has(hook.pluginId)),
      },
      {
        logger: log,
        catchErrors: false,
        voidHookTimeoutMsByHook: {
          gateway_start: PLUGIN_SERVICE_REPLACEMENT_STOP_TIMEOUT_MS,
          gateway_stop: PLUGIN_SERVICE_REPLACEMENT_STOP_TIMEOUT_MS,
        },
      },
    );
    const context = {
      port,
      config,
      workspaceDir: pluginWorkspaceDir,
      getCron,
    };
    await withPluginHttpRouteRegistry(registry, () =>
      start
        ? hooks.runGatewayStart({ port }, context)
        : hooks.runGatewayStop({ reason: "plugin replacement" }, context),
    );
  };
  const prepareRegistrationFailureCleanup =
    (config: OpenClawConfig) =>
    (registry: PluginRegistry, record: PluginRegistry["plugins"][number]) => {
      const stopHooks = registry.typedHooks.filter(
        (hook) => hook.pluginId === record.id && hook.hookName === "gateway_stop",
      );
      if (stopHooks.length) {
        // Failed contributions disappear synchronously; declared cleanup remains with
        // the instance until its asynchronous disposal settles.
        const cleanupRegistry = { ...registry, typedHooks: stopHooks };
        getPluginInstance(record)?.lifecycle.onDispose(() =>
          runLifecycleHooks(cleanupRegistry, false, config),
        );
      }
    };
  const retireUnpublished = async (
    registry: PluginRegistry,
    config: OpenClawConfig,
    services: PluginServicesHandle | undefined,
  ) => {
    const errors: unknown[] = [];
    // A caller's deadline cannot release rejected B/C ownership. Retain the raw
    // completion with the Gateway, including failures that must block later retries.
    retainRetirement(async () => {
      const failures: unknown[] = [];
      await attempt(failures, async () => {
        await services?.stop({ strict: true, pluginIds: changedPluginIds });
      });
      const result = await disposePluginRegistryInstances(registry, previousRegistry);
      for (const { error, hookId } of result.failures) {
        failures.push(
          ...(hookId === "instance" ? await collectResourceFailures([error]) : [error]),
        );
      }
      if (failures.length) {
        throw new AggregateError(failures, "Unpublished plugin resource cleanup failed");
      }
      return result;
    });
    for (const record of registry.plugins) {
      if (!previousRegistry.plugins.includes(record)) {
        // Disposal joins admitted consumers before running the legacy stop hook,
        // including when the caller's bounded cleanup observation times out.
        const instance = getPluginInstance(record);
        if (!instance?.disposing) {
          prepareRegistrationFailureCleanup(config)(registry, record);
          instance?.quiesce();
        }
      }
    }
    await attempt(errors, async () => {
      await services?.stop({
        strict: true,
        deadlineAtMs: Date.now() + PLUGIN_SERVICE_REPLACEMENT_STOP_TIMEOUT_MS,
        pluginIds: changedPluginIds,
      });
    });
    await attempt(errors, async () => {
      const result = await withPluginHostCleanupTimeout("unpublished plugin resources", () =>
        disposePluginRegistryInstances(registry, previousRegistry),
      );
      recordCleanup(result);
      errors.push(...result.failures.map((entry) => entry.error));
    });
    if (errors.length) {
      throw new AggregateError(errors, "Unpublished plugin resource cleanup failed");
    }
  };
  return {
    attempt,
    stopPreviousServices: async (services: PluginServicesHandle | null, strict: boolean) => {
      try {
        await services?.stop({
          strict: true,
          deadlineAtMs: Date.now() + PLUGIN_SERVICE_REPLACEMENT_STOP_TIMEOUT_MS,
          pluginIds: changedPluginIds,
        });
      } catch (error) {
        pendingServiceCleanup = strict ? getPluginServiceCleanupSettlement(error) : undefined;
        throw error;
      }
    },
    selectResourceHandoff: (nextRegistry: PluginRegistry, requestedIds: ReadonlySet<string>) => {
      const retainedRecords = new Set(nextRegistry.plugins);
      changedPluginIds.clear();
      for (const pluginId of [
        ...requestedIds,
        ...previousRegistry.plugins
          .filter((record) => !retainedRecords.has(record))
          .map((record) => record.id),
        ...nextRegistry.plugins
          .filter((record) => !previousRegistry.plugins.includes(record))
          .map((record) => record.id),
      ]) {
        changedPluginIds.add(pluginId);
      }
      return new Set(
        nextRegistry.plugins
          .filter(
            (record) =>
              changedPluginIds.has(record.id) &&
              record.enabled &&
              record.status === "loaded" &&
              record.format !== "bundle" &&
              previousRegistry.plugins.some(
                (previous) => previous.id === record.id && getPluginInstance(previous),
              ),
          )
          .map((record) => record.id),
      );
    },
    isBlockingStopError: (error: unknown) =>
      !pendingServiceCleanup || error !== pendingServiceCleanup.error,
    rethrowServiceStopTimeout: () => {
      if (pendingServiceCleanup) {
        // Replacement failed its stop deadline. Only recovery can observe the
        // original settlement before disposal and fresh resource acquisition.
        throw pendingServiceCleanup.error;
      }
    },
    includeServiceStopFailure: (error: unknown) =>
      pendingServiceCleanup && pendingServiceCleanup.error !== error
        ? new AggregateError([pendingServiceCleanup.error, error], "Previous plugin cleanup failed")
        : error,
    reserveResourceHandoff: (pluginIds: ReadonlySet<string>) => {
      const releases: Array<() => void> = [];
      const release = () => releases.splice(0).forEach((close) => close());
      try {
        for (const record of previousRegistry.plugins) {
          const instance = pluginIds.has(record.id) && getPluginInstance(record);
          if (instance) {
            releases.push(instance.reserveReplacement());
          }
        }
      } catch (error) {
        release();
        throw error;
      }
      return release;
    },
    drainInstances,
    drainBeforeReplacement: async (
      pluginIds: ReadonlySet<string>,
      signal: AbortSignal,
      reportStatus: (status: GatewayPluginReloadStatus) => void,
    ) => {
      if (pluginIds.size) {
        await drainWithDeadline(pluginIds, signal, reportStatus, "reloading");
      }
    },
    drainForRecovery: async (
      signal: AbortSignal,
      reportStatus: (status: GatewayPluginReloadStatus) => void,
    ) => {
      await drainWithDeadline(changedPluginIds, signal, reportStatus, "recovering");
    },
    disposeInstances,
    runLifecycleHooks,
    prepareRegistrationFailureCleanup,
    retireUnpublished,
  };
}

async function collectResourceFailures(errors: readonly unknown[]): Promise<unknown[]> {
  const failures: unknown[] = [];
  for (const error of errors) {
    if (error instanceof PluginInstanceDrainTimeoutError) {
      // Revoked tokens are not completion: retain the original diagnostic until
      // its leases actually return, without forgiving any resource cleanup error.
      await error.settled;
    } else {
      failures.push(error);
    }
  }
  return failures;
}

/** Keeps cleanup warnings bounded in receipts while retaining full diagnostic logs. */
export function createPluginReloadDiagnostics(log: ReturnType<typeof createSubsystemLogger>) {
  const warnings = new Set<string>();
  const recordWarning = (warning: string) => {
    // Keep tool/RPC results bounded; complete cleanup diagnostics remain in the log.
    if (warnings.size < 8) {
      warnings.add(truncateUtf16Safe(warning, 240));
    } else {
      warnings.add("Additional plugin cleanup warnings were recorded in the Gateway log.");
    }
  };
  const recordCleanup = (result: PluginHostCleanupResult) => {
    for (const pluginId of result.deferredPluginIds ?? []) {
      const warning = `Plugin ${pluginId} cleanup is deferred until its admitted work finishes.`;
      log.info(warning);
      recordWarning(warning);
    }
    for (const failure of result.failures) {
      recordWarning(
        `Plugin ${failure.pluginId} cleanup failed (${failure.hookId}): ${formatErrorMessage(failure.error)}`,
      );
    }
  };
  const cleanup = async (label: string, run: () => void | Promise<void>) => {
    try {
      await run();
    } catch (error) {
      const warning = `${label}: ${formatErrorMessage(error)}`;
      log.warn(warning);
      recordWarning(warning);
    }
  };
  return { warnings, recordWarning, recordCleanup, cleanup };
}
