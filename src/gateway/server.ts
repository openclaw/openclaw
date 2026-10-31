/**
 * Lazy public entrypoint for the gateway server implementation.
 *
 * Keeping `server-start` behind dynamic import lets light-weight callers import
 * server types and helpers without paying the full startup dependency graph.
 */
import { performance } from "node:perf_hooks";
import { measureGatewayBootstrapStep } from "../cli/startup-trace.js";
import { installDatabaseProcessRole } from "../infra/database-engine/admission-scope.js";
import { formatErrorMessage } from "../infra/errors.js";
import { supportsSpawnBrokerCommandTransport } from "../process/spawn-broker/pipe.js";
import { getProcessCleanupBudget } from "../process/supervisor/cleanup-budget.js";
import { settlesWithin } from "../shared/settle-within.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { formatGatewayPendingCloseSteps, measureGatewayCloseStep } from "./restart-trace.js";
import type { GatewayServer, GatewayServerOptions } from "./server-public.js";
import {
  GatewayShutdownCleanupRetainedError,
  GatewayStartupCleanupError,
  rethrowGatewayStartupError,
} from "./server-shutdown.js";

export { truncateCloseReason } from "./server/close-reason.js";
export type { GatewayServer, GatewayServerOptions } from "./server-public.js";

async function loadServerStart() {
  return await measureGatewayBootstrapStep(
    "gateway.server-start-import",
    () => import("./server-start.js"),
  );
}

async function closeWithRuntimeCleanup(
  name: string,
  close: (() => Promise<void>) | undefined,
  run: () => Promise<void>,
  options: Parameters<GatewayServer["close"]>[0],
): Promise<void> {
  let failure: { error: unknown } | undefined;
  try {
    await close?.();
  } catch (error) {
    failure = { error };
  }
  try {
    const pending = measureGatewayCloseStep(`shutdown.${name}`, run);
    const budget = getProcessCleanupBudget();
    const graceMs = budget ? Math.max(0, budget.deadline - performance.now()) : 5_000;
    if (!options?.exitAfterClose) {
      await pending;
    } else if (!(await settlesWithin(pending, graceMs))) {
      const message = `${name} cleanup exceeded process shutdown deadline; resources remain; pending: ${formatGatewayPendingCloseSteps()}`;
      budget?.warn(message);
      throw new GatewayShutdownCleanupRetainedError([new Error(message)], message);
    }
  } catch (error) {
    if (failure) {
      throw new AggregateError(
        [failure.error, error],
        `${formatErrorMessage(failure.error)}; ${formatErrorMessage(error)}`,
        { cause: error },
      );
    }
    throw error;
  }
  if (failure) {
    throw failure.error;
  }
}

/** Starts the gateway server after lazily loading the full server implementation. */
export async function startGatewayServer(
  port = 18789,
  opts: GatewayServerOptions = {},
): ReturnType<typeof import("./server-start.js").startGatewayServerCore> {
  installDatabaseProcessRole("gateway");
  const { installGatewayDatabaseEngine } = await import("./server-database-engine.js");
  await installGatewayDatabaseEngine(
    opts.startupConfigSnapshotRead?.snapshot,
    opts.startupConfigSnapshotRead?.databaseEngineSelection,
  );
  const { initializeSqliteRuntime } = await import("../infra/sqlite-runtime-initialize.js");
  await initializeSqliteRuntime();
  const { acquireGatewayLock } = await import("../infra/gateway-lock.js");
  const ownedLock = opts.gatewayStateOwner
    ? null
    : await acquireGatewayLock({ port, listenerMode: "foreground" });
  const gatewayStateOwner = opts.gatewayStateOwner ?? ownedLock ?? undefined;
  let close: GatewayServer["close"] | undefined;
  let detachOwner: (() => void) | undefined;
  try {
    const { captureGatewayStateOwner } = await import("../infra/gateway-state-owner.js");
    const { createSubsystemLogger } = await import("../logging/subsystem.js");
    const log = createSubsystemLogger("gateway");
    const databasePath = resolveOpenClawStateSqlitePath();
    gatewayStateOwner?.assertDatabaseAccess(databasePath);
    const signal = captureGatewayStateOwner(databasePath)?.signal;
    const onOwnerLost = () => {
      const reason = String(signal?.reason);
      const restart = close ? opts.hotReloadRecovery?.(reason) : undefined;
      if (close && (!restart || restart.status === "failed")) {
        void close({ reason }).catch((error: unknown) => {
          log.error(`Gateway lost ownership cleanup failed: ${String(error)}`);
        });
      }
    };
    signal?.addEventListener("abort", onOwnerLost, { once: true });
    detachOwner = () => signal?.removeEventListener("abort", onOwnerLost);
    signal?.throwIfAborted();
    const server = await startGatewayServerWithRuntime(port, { ...opts, gatewayStateOwner });
    let closing: Promise<void> | undefined;
    const closeServer: GatewayServer["close"] = (closeOptions) => {
      detachOwner?.();
      return (closing ??= (async () => {
        await server.close(closeOptions);
        // A failed join retains ownership: another starter must not enter over live work.
        await ownedLock?.release();
      })());
    };
    close = closeServer;
    if (signal?.aborted) {
      const reason = signal.reason;
      return await rethrowGatewayStartupError(reason, () =>
        closeServer({
          reason: String(reason),
          exitAfterClose: opts.exitAfterStartupFailure?.(reason),
        }),
      );
    }
    return {
      ...server,
      close: closeServer,
    };
  } catch (error) {
    detachOwner?.();
    if (!close && !(error instanceof GatewayStartupCleanupError)) {
      await ownedLock?.release();
    }
    throw error;
  }
}

async function startGatewayServerWithRuntime(
  port: number,
  opts: GatewayServerOptions,
): ReturnType<typeof import("./server-start.js").startGatewayServerCore> {
  const startupStartedAt = opts.startupStartedAt ?? Date.now();
  if (process.platform === "linux") {
    const [{ initializeGatewayExecCgroup }, { resolveStateDir }, { createSubsystemLogger }] =
      await Promise.all([
        import("../process/linux-exec-cgroup-startup.js"),
        import("../config/paths.js"),
        import("../logging/subsystem.js"),
      ]);
    createSubsystemLogger("gateway").info(await initializeGatewayExecCgroup(resolveStateDir()));
  }
  let stopDatabaseAdmission: (() => Promise<void>) | undefined;
  const start = async () => {
    const { createSqliteReadOnlyWorkerScope } = await import("../infra/sqlite-readonly-worker.js");
    const readOnlyWorkers = createSqliteReadOnlyWorkerScope();
    const { withAgentDatabaseStartupAdmission } =
      await import("../state/agent-database-startup.js");
    try {
      const { bindAuthProfileFileObservationReaders } =
        await import("../agents/auth-profiles/file-state.js");
      const server = await readOnlyWorkers.run(() => {
        bindAuthProfileFileObservationReaders();
        return withAgentDatabaseStartupAdmission(
          async (admission) => {
            stopDatabaseAdmission = () => admission.stop();
            const mod = await loadServerStart();
            opts.gatewayStateOwner?.assertDatabaseAccess(resolveOpenClawStateSqlitePath());
            return mod.startGatewayServerCore(port, { ...opts, startupStartedAt });
          },
          { deferInspections: !opts.updateCanary },
        );
      });
      return {
        ...server,
        close: (closeOptions: Parameters<typeof server.close>[0]) =>
          readOnlyWorkers.run(() =>
            closeWithRuntimeCleanup(
              "read-only-workers",
              () => server.close(closeOptions),
              () => readOnlyWorkers.close(),
              closeOptions,
            ),
          ),
      };
    } catch (error) {
      return await rethrowGatewayStartupError(error, () =>
        closeWithRuntimeCleanup("read-only-workers", undefined, () => readOnlyWorkers.close(), {
          exitAfterClose: opts.exitAfterStartupFailure?.(error),
        }),
      );
    }
  };
  // Gateway brokerage targets Linux's page-table copy cost.
  if (process.platform !== "linux" || !supportsSpawnBrokerCommandTransport()) {
    return await start();
  }
  const { startGatewaySpawnBroker, runWithSpawnBroker } =
    await import("../process/spawn-broker/context.js");
  let logger: { info: (message: string) => void } | undefined;
  const broker = await startGatewaySpawnBroker({
    onReady(pid, restarted) {
      if (restarted) {
        logger?.info(`spawn broker restarted pid=${pid}`);
      }
    },
    async onStartupFailure(message) {
      const { createSubsystemLogger } = await import("../logging/subsystem.js");
      createSubsystemLogger("gateway").error(message);
    },
  });
  if (!broker) {
    return await start();
  }
  const closeBroker = async () => {
    // Core can retain connection work before reaching its process join. Keep the
    // broker alive until command results, output, and service-child cleanup settle.
    const { shutdownProcessSupervisor } = await import("../process/supervisor/index.js");
    await measureGatewayCloseStep("shutdown.process-supervisor", shutdownProcessSupervisor);
    // A failed required core join can stop before the admission sidecar runs.
    await measureGatewayCloseStep("shutdown.database-admission", () => stopDatabaseAdmission?.());
    try {
      const { closeSqliteReadOnlyWorkersForBroker } =
        await import("../infra/sqlite-readonly-worker.js");
      await measureGatewayCloseStep("shutdown.broker-read-only-workers", () =>
        closeSqliteReadOnlyWorkersForBroker(broker),
      );
    } finally {
      // Readers that did not close remain attached children for broker termination.
      await measureGatewayCloseStep("shutdown.spawn-broker", () => broker.close());
    }
  };
  try {
    const { createSubsystemLogger } = await import("../logging/subsystem.js");
    logger = createSubsystemLogger("gateway");
    logger.info(`spawn broker ready pid=${broker.pid}`);
    const server = await runWithSpawnBroker(broker, start);
    return {
      ...server,
      close: (closeOptions) =>
        runWithSpawnBroker(broker, () =>
          // The tail keeps joining in order even when its process owner must proceed to exit.
          closeWithRuntimeCleanup(
            "spawn-broker-runtime",
            () => server.close(closeOptions),
            closeBroker,
            closeOptions,
          ),
        ),
    };
  } catch (error) {
    return await rethrowGatewayStartupError(error, () =>
      closeWithRuntimeCleanup("spawn-broker-runtime", undefined, closeBroker, {
        exitAfterClose: opts.exitAfterStartupFailure?.(error),
      }),
    );
  }
}
