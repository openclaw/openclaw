/**
 * Lazy public entrypoint for the gateway server implementation.
 *
 * Keeping `server-start` behind dynamic import lets light-weight callers import
 * server types and helpers without paying the full startup dependency graph.
 */
import { measureGatewayBootstrapStep } from "../cli/startup-trace.js";

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
  opts: import("./server-public.js").GatewayServerOptions = {},
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
        withAgentDatabaseStartupAdmission(async (admission) => {
          stopDatabaseAdmission = () => admission.stop();
          const mod = await loadServerStart();
          return mod.startGatewayServerCore(port, { ...opts, startupStartedAt });
        }),
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
      await readOnlyWorkers.close();
      throw error;
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
    await closeBroker();
    throw error;
  }
}
