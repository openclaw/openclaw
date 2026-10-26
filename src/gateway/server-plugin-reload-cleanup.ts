import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  getPreparedModelRuntimeBorrowedSnapshot,
  getPreparedModelRuntimePluginGeneration,
} from "../agents/prepared-model-runtime-generation-scope.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
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
import { getPluginInstance, type PluginInstanceHandle } from "../plugins/plugin-instance-scope.js";
import { collectRegistryInvocationInstances } from "../plugins/plugin-invocation-scope.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import { disposePluginRegistryInstances } from "../plugins/runtime.js";
import {
  PLUGIN_SERVICE_REPLACEMENT_STOP_TIMEOUT_MS,
  getPluginServiceCleanupSettlement,
  type PluginServicesHandle,
} from "../plugins/services.js";
import type { GatewayPluginReloadStatus } from "./server-plugin-reload-status.types.js";

const PLUGIN_RELOAD_ADMITTED_WORK_TIMEOUT_MS = 60_000;

// Keep acquisition facts in raw logs; each egress applies its own redaction policy.
function logRetainedReferences(
  instances: readonly PluginInstanceHandle[],
  phase: "queued" | "timeout",
  log: Pick<ReturnType<typeof createSubsystemLogger>, "info" | "warn">,
): void {
  const selected = instances
    .slice(0, 8)
    .map((instance) => instance.retentionSnapshot({ limit: 8 }));
  log[phase === "timeout" ? "warn" : "info"](
    `Plugin retained references (${phase}); a turn awaiting its own retained work cannot drain.`,
    { instances: selected, omittedInstances: Math.max(0, instances.length - selected.length) },
  );
}

export class PluginAdmittedWorkTimeoutError extends Error {
  /** Previous-generation instances whose pre-stop drain expired, from the failing registry. */
  readonly instances: readonly PluginInstanceHandle[];

  constructor(
    pluginIds: ReadonlySet<string>,
    instances: readonly PluginInstanceHandle[],
    cause: PluginHostCleanupTimeoutError,
    timeoutMs: number,
  ) {
    const ids = [...pluginIds].join(", ");
    super(
      `plugin ${ids} admitted work did not settle within ${timeoutMs / 1_000}s; the previous plugin generation stays active. Retry \`openclaw plugins reload ${[...pluginIds].join(" ")}\` after the work finishes, or use --wait for a bounded 10-minute drain that blocks new agent runs. If an agent turn holds this plugin, end that turn first or use the plugins tool with action reloadAndResume; waiting inside the same turn cannot make progress.`,
      { cause },
    );
    this.instances = instances;
  }
}

/** Owns resource handoff and rejected-registration cleanup for one reload transaction. */
export function createPluginReloadCleanup({
  previousRegistry,
  changedPluginIds,
  port,
  pluginWorkspaceDir,
  getCron,
  abortSignal,
  log,
  recordCleanup,
  recordWarning,
  retainRetirement,
  waitForDrain = false,
}: {
  waitForDrain?: boolean;
  previousRegistry: PluginRegistry;
  changedPluginIds: Set<string>;
  port: number;
  pluginWorkspaceDir: string | undefined;
  getCron: () => PluginHookGatewayCronService;
  abortSignal: AbortSignal;
  log: ReturnType<typeof createSubsystemLogger>;
  recordCleanup: (result: PluginHostCleanupResult) => void;
  recordWarning: (warning: string) => void;
  retainRetirement: (retire: () => Promise<PluginHostCleanupResult>) => void;
}) {
  let pendingServiceCleanup: ReturnType<typeof getPluginServiceCleanupSettlement>;
  // Match the existing ten-minute plugin lifecycle wait budget for an explicit wait.
  const admittedWorkTimeoutMs = PLUGIN_RELOAD_ADMITTED_WORK_TIMEOUT_MS * (waitForDrain ? 10 : 1);
  let admittedWorkDeadlineAtMs: number | undefined;
  let retainedWorkQueued = false;
  const quiescedInstances: PluginInstanceHandle[] = [];
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
    signal?: AbortSignal,
  ) => {
    for (const record of registry.plugins) {
      if (!pluginIds.has(record.id)) {
        continue;
      }
      signal?.throwIfAborted();
      const drain = () => getPluginInstance(record)?.drain({ includeConsumers: true, signal });
      const result = signal
        ? await drain()
        : await withPluginHostCleanupTimeout(`plugin ${record.id} admitted work`, drain);
      if (result?.errors.length) {
        throw new AggregateError(result.errors, `Plugin ${record.id} work did not drain`);
      }
    }
  };
  const admittedWorkDeadline = () =>
    (admittedWorkDeadlineAtMs ??= performance.now() + admittedWorkTimeoutMs);
  // Budgets use the monotonic clock their timers run on; status reports a wall-clock deadline.
  const wallClockDeadline = (deadlineAtMs: number) => Date.now() + deadlineAtMs - performance.now();
  const observeDrain = async (
    label: string,
    signal: AbortSignal,
    deadlineAtMs: number,
    run: (signal: AbortSignal) => Promise<unknown>,
  ) => {
    const observation = new AbortController();
    const currentSignal = AbortSignal.any([signal, observation.signal]);
    try {
      await withPluginHostCleanupTimeout(
        label,
        () => run(currentSignal),
        Math.max(0, deadlineAtMs - performance.now()),
      );
    } finally {
      // Detach observers when the wait ends; admitted work keeps its own lifetime.
      observation.abort();
    }
  };
  const drainForRecovery = async (
    signal: AbortSignal,
    reportStatus: (status: GatewayPluginReloadStatus) => void,
  ) => {
    const deadlineAtMs = performance.now() + PLUGIN_RELOAD_ADMITTED_WORK_TIMEOUT_MS;
    reportStatus({
      phase: "recovering",
      pluginIds: [...changedPluginIds],
      deadlineAtMs: wallClockDeadline(deadlineAtMs),
      reason: "Waiting for cleanup and admitted work before restoring the previous plugin runtime.",
    });
    try {
      await observeDrain("previous plugin admitted work", signal, deadlineAtMs, async (current) => {
        if (pendingServiceCleanup) {
          await racePromiseWithAbortSignal(pendingServiceCleanup.settled, current);
        }
        await drainInstances(previousRegistry, changedPluginIds, current);
      });
    } catch (error) {
      if (error instanceof PluginHostCleanupTimeoutError) {
        throw new Error("Previous plugin work did not settle before the recovery deadline", {
          cause: error,
        });
      }
      throw error;
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
            const instance = getPluginInstance(record);
            const result = await instance?.dispose(
              instance.disposing
                ? undefined
                : async () => {
                    const { runPluginHostLifecycleCleanup } =
                      await import("../plugins/host-hook-cleanup.js");
                    const host = await runPluginHostLifecycleCleanup({
                      registry,
                      pluginId: record.id,
                      reason: "restart",
                    });
                    recordCleanup(host);
                    if (host.failures.length) {
                      throw new AggregateError(
                        host.failures.map(({ error }) => error),
                        `Plugin ${record.id} lifecycle cleanup failed`,
                      );
                    }
                  },
            );
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
      ...(start ? { abortSignal } : {}),
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
  const previousInstances = (pluginIds: ReadonlySet<string>) =>
    previousRegistry.plugins.flatMap((record) => {
      const instance = pluginIds.has(record.id) && getPluginInstance(record);
      return instance ? [instance] : [];
    });
  const drainRetainedWork = async (
    pluginIds: ReadonlySet<string>,
    signal: AbortSignal,
    reportStatus: (status: GatewayPluginReloadStatus) => void,
    { includeConsumers = false, includeCalls = false } = {},
  ) => {
    const instances = previousInstances(pluginIds);
    const count = instances.reduce(
      (total, instance) =>
        total + instance.retainedWorkCount + (includeCalls ? instance.ordinaryCallCount : 0),
      0,
    );
    if (!instances.length || (!count && !includeConsumers)) {
      return;
    }
    retainedWorkQueued ||= count > 0;
    const deadlineAtMs = admittedWorkDeadline();
    const reason = count
      ? `Plugin replacement queued behind ${count} ${includeCalls ? "admitted" : "retained"} work item(s) for plugin ${[...pluginIds].join(", ")}; new agent runs wait up to the ${admittedWorkTimeoutMs / 1_000}s drain budget.${waitForDrain ? " Press Ctrl+C to cancel the waiting reload." : ""}`
      : "Waiting for admitted plugin cleanup before replacing it.";
    reportStatus({
      phase: "reloading",
      pluginIds: [...changedPluginIds],
      deadlineAtMs: wallClockDeadline(deadlineAtMs),
      reason,
    });
    log.info(reason);
    logRetainedReferences(instances, "queued", log);
    try {
      await observeDrain("retained plugin work", signal, deadlineAtMs, (current) =>
        Promise.all(
          instances.map((instance) =>
            includeConsumers
              ? instance.waitForIdle(current)
              : instance.waitForRetainedWork(current, { includeConsumers: false, includeCalls }),
          ),
        ),
      );
    } catch (error) {
      if (error instanceof PluginHostCleanupTimeoutError) {
        logRetainedReferences(instances, "timeout", log);
        throw new PluginAdmittedWorkTimeoutError(
          pluginIds,
          instances,
          error,
          admittedWorkTimeoutMs,
        );
      }
      throw error;
    }
  };
  return {
    attempt,
    drainRetainedWork,
    stopPreviousServices: async (
      services: PluginServicesHandle | null,
      strict: boolean,
      pluginIds: ReadonlySet<string> = changedPluginIds,
    ) => {
      try {
        await services?.stop({
          strict: true,
          deadlineAtMs: Date.now() + PLUGIN_SERVICE_REPLACEMENT_STOP_TIMEOUT_MS,
          pluginIds,
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
    assertResourceHandoff: (pluginIds: ReadonlySet<string>) => {
      const releases: Array<() => void> = [];
      const generation = getPreparedModelRuntimePluginGeneration();
      const heldInstances =
        generation && getPreparedModelRuntimeBorrowedSnapshot(generation)
          ? new Set(
              [generation.pluginRegistry, generation.inboundPluginRegistry].flatMap((registry) =>
                registry ? Array.from(collectRegistryInvocationInstances(registry)) : [],
              ),
            )
          : undefined;
      for (const record of previousRegistry.plugins) {
        if (pluginIds.has(record.id)) {
          const instance = getPluginInstance(record);
          if (instance?.hasActiveCall) {
            throw new Error(
              `Plugin ${record.id} cannot replace itself from its own active call; retry after the call finishes.`,
            );
          }
          // A turn retains its instances between callbacks; waiting here would wait on itself.
          if (instance && heldInstances?.has(instance)) {
            throw new Error(
              `Plugin ${record.id} cannot replace itself from its own active turn; retry after the turn finishes.`,
            );
          }
        }
      }
      for (const instance of previousInstances(pluginIds)) {
        releases.push(instance.reserveReplacement());
      }
      return () => releases.forEach((release) => release());
    },
    drainInstances,
    drainMemory: async (drain: () => Promise<{ errors: readonly unknown[] }>) => {
      try {
        const result = await drain();
        for (const error of result.errors) {
          const warning = `Memory cleanup failed: ${formatErrorMessage(error)}`;
          log.warn(warning);
          recordWarning(warning);
        }
      } catch (error) {
        if (!(error instanceof PluginHostCleanupTimeoutError)) {
          throw error;
        }
        log.warn(error.message);
        recordWarning(error.message);
      }
    },
    quiesceInstances: () => {
      for (const record of previousRegistry.plugins) {
        const instance = changedPluginIds.has(record.id) && getPluginInstance(record);
        if (instance && instance.quiesce()) {
          quiescedInstances.push(instance);
        }
      }
    },
    drainBeforeReplacement: async (
      pluginIds: ReadonlySet<string>,
      signal: AbortSignal,
      reportStatus: (status: GatewayPluginReloadStatus) => void,
    ) => {
      // Admission is closed and sidecars drained; observe without quiescing again.
      await drainRetainedWork(pluginIds, signal, reportStatus, {
        includeConsumers: true,
        includeCalls: true,
      });
      if (retainedWorkQueued) {
        recordWarning("Plugin replacement waited for retained work to finish.");
      }
    },
    resumeInstances: () => quiescedInstances.forEach((instance) => instance.resume()),
    drainForRecovery,
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
