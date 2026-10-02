/**
 * Lazy public entrypoint for the gateway server implementation.
 *
 * Keeping `server-start` behind dynamic import lets light-weight callers import
 * server types and helpers without paying the full startup dependency graph.
 */
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import type { GatewayServerOptions } from "./server-public.js";
import { GatewayStartupCleanupError } from "./server-shutdown.js";

export { truncateCloseReason } from "./server/close-reason.js";
export type { GatewayServer, GatewayServerOptions } from "./server-public.js";

async function emitStartupTrace(name: string, durationMs: number, totalMs: number): Promise<void> {
  if (!process.env.OPENCLAW_GATEWAY_STARTUP_TRACE) {
    return;
  }
  const { formatConsoleDiagnosticLine } = await import("../logging/json-console-line.js");
  const message = `[gateway] startup trace: ${name} ${durationMs.toFixed(1)}ms total=${totalMs.toFixed(1)}ms`;
  process.stderr.write(`${formatConsoleDiagnosticLine({ level: "info", message })}\n`);
}

async function loadServerStart() {
  const startupStartedAt = performance.now();
  const before = performance.now();
  try {
    return await import("./server-start.js");
  } finally {
    const now = performance.now();
    await emitStartupTrace("gateway.server-start-import", now - before, now - startupStartedAt);
  }
}

/** Starts the gateway server after lazily loading the full server implementation. */
export async function startGatewayServer(
  port = 18789,
  opts: GatewayServerOptions = {},
): ReturnType<typeof import("./server-start.js").startGatewayServerCore> {
  const { acquireGatewayLock } = await import("../infra/gateway-lock.js");
  const ownedLock = opts.gatewayStateOwner ? null : await acquireGatewayLock({ port });
  const gatewayStateOwner = opts.gatewayStateOwner ?? ownedLock ?? undefined;
  try {
    gatewayStateOwner?.assertDatabaseAccess(resolveOpenClawStateSqlitePath());
    const mod = await loadServerStart();
    const server = await mod.startGatewayServerCore(port, { ...opts, gatewayStateOwner });
    return {
      ...server,
      close: async (closeOptions) => {
        await server.close(closeOptions);
        await ownedLock?.release();
      },
    };
  } catch (error) {
    if (!(error instanceof GatewayStartupCleanupError)) {
      await ownedLock?.release();
    }
    throw error;
  }
}

/** Clears prepared model-catalog generations between tests. */
export async function resetPreparedModelCatalogForTest(): Promise<void> {
  const mod = await loadServerStart();
  await mod.resetPreparedModelCatalogForTestCore();
}
