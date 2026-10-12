import { AsyncLocalStorage } from "node:async_hooks";

type AgentDatabasePreparation = {
  waitForAgentPreparation(
    agentId: string,
    options?: { env?: NodeJS.ProcessEnv; signal?: AbortSignal },
  ): Promise<void> | undefined;
};

const preparation = new AsyncLocalStorage<() => AgentDatabasePreparation | undefined>();

/** Carry readiness observation without borrowing startup's database access. */
export function withAgentDatabasePreparationContext<T>(
  resolveOwner: () => AgentDatabasePreparation | undefined,
  run: () => T,
): T {
  return preparation.run(resolveOwner, run);
}

export function waitForAgentDatabasePreparation(
  agentId: string,
  options?: { env?: NodeJS.ProcessEnv; signal?: AbortSignal },
): Promise<void> | undefined {
  return preparation.getStore()?.()?.waitForAgentPreparation(agentId, options);
}
