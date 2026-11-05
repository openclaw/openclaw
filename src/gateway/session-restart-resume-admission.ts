import type { GatewayRequestContext } from "./server-methods/types.js";

/** Shared stores may be discovered through a logical agent before their physical owner is writable. */
export async function waitForRestartStoreWriteAdmission(
  {
    context,
    signal,
    log,
  }: {
    context: Pick<GatewayRequestContext, "agentDatabaseStartup">;
    signal: AbortSignal;
    log: { warn: (message: string) => void };
  },
  target: { agentId: string; physicalAgentId: string; env?: NodeJS.ProcessEnv },
): Promise<boolean> {
  try {
    await context.agentDatabaseStartup?.waitForAgentPreparation(target.physicalAgentId, {
      env: target.env,
      signal,
      forWrite: true,
    });
    return true;
  } catch (error) {
    signal.throwIfAborted();
    log.warn(`Skipped restart resume for agent ${target.agentId}: ${String(error)}`);
    return false;
  }
}
