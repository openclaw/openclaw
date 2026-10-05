/**
 * Lazy public entrypoint for the gateway server implementation.
 *
 * Keeping `server-start` behind dynamic import lets light-weight callers import
 * server types and helpers without paying the full startup dependency graph.
 */
import { measureGatewayBootstrapStep } from "../cli/startup-trace.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import type { GatewayServer, GatewayServerOptions } from "./server-public.js";
import { GatewayStartupCleanupError, rethrowGatewayStartupError } from "./server-shutdown.js";
import { isGatewayRestrictedUpgradeStartup } from "./server-upgrade-startup-mode.js";

export { truncateCloseReason } from "./server/close-reason.js";
export type { GatewayServer, GatewayServerOptions } from "./server-public.js";

async function loadServerStart() {
  return await measureGatewayBootstrapStep(
    "gateway.server-start-import",
    () => import("./server-start.js"),
  );
}

/** Starts the gateway server after lazily loading the full server implementation. */
export async function startGatewayServer(
  port = 18789,
  opts: GatewayServerOptions = {},
): ReturnType<typeof import("./server-start.js").startGatewayServerCore> {
  const { initializeSqliteRuntimeCapabilities } = await import("../infra/bun-sqlite-library.js");
  await initializeSqliteRuntimeCapabilities();
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
        closeServer({ reason: String(reason) }),
      );
    }
    return { ...server, close };
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
  let stopDatabaseAdmission: (() => Promise<void>) | undefined;
  const start = async () => {
    const { createSqliteReadOnlyWorkerScope } = await import("../infra/sqlite-readonly-worker.js");
    const readOnlyWorkers = createSqliteReadOnlyWorkerScope();
    const { withAgentDatabaseStartupAdmission } =
      await import("../state/agent-database-startup.js");
    try {
      const server = await readOnlyWorkers.run(() =>
        withAgentDatabaseStartupAdmission(
          async (admission) => {
            stopDatabaseAdmission = () => admission.stop();
            const mod = await loadServerStart();
            opts.gatewayStateOwner?.assertDatabaseAccess(resolveOpenClawStateSqlitePath());
            return mod.startGatewayServerCore(port, { ...opts, startupStartedAt });
          },
          { deferInspections: !isGatewayRestrictedUpgradeStartup(opts) },
        ),
      );
      return {
        ...server,
        close: (closeOptions: Parameters<typeof server.close>[0]) =>
          readOnlyWorkers.run(async () => {
            try {
              await server.close(closeOptions);
            } finally {
              await readOnlyWorkers.close();
            }
          }),
      };
    } catch (error) {
      return await rethrowGatewayStartupError(error, () => readOnlyWorkers.close());
    }
  };
  // Transferable stdio sockets are a Node contract; Bun keeps its native transport.
  if (process.platform !== "linux" || process.versions.bun) {
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
    // A failed required core join can stop before the admission sidecar runs.
    await stopDatabaseAdmission?.();
    await broker.close();
  };
  try {
    const { createSubsystemLogger } = await import("../logging/subsystem.js");
    logger = createSubsystemLogger("gateway");
    logger.info(`spawn broker ready pid=${broker.pid}`);
    const server = await runWithSpawnBroker(broker, start);
    return {
      ...server,
      close: (closeOptions) =>
        runWithSpawnBroker(broker, async () => {
          try {
            await server.close(closeOptions);
          } finally {
            // Process scopes and relay extinction joins finish before their transport closes.
            await closeBroker();
          }
        }),
    };
  } catch (error) {
    return await rethrowGatewayStartupError(error, closeBroker);
  }
}
