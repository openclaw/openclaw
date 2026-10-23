import { AsyncLocalStorage } from "node:async_hooks";
import { getAsyncWorkSignal } from "../shared/async-work-scope.js";

type AgentDatabasePreparation = {
  waitForAgentPreparation(
    agentId: string,
    options?: { env?: NodeJS.ProcessEnv; signal?: AbortSignal; forWrite?: boolean },
  ): Promise<void> | undefined;
};

const preparation = new AsyncLocalStorage<() => AgentDatabasePreparation | undefined>();

/** Carry readiness observation without borrowing startup's database access. */
export function withAgentDatabasePreparationContext<T>(
  resolveOwner: () => AgentDatabasePreparation | undefined,
  run: () => T,
): T {
  return preparation.getStore() === resolveOwner ? run() : preparation.run(resolveOwner, run);
}

export function waitForAgentDatabasePreparation(
  agentId: string,
  options?: { env?: NodeJS.ProcessEnv; signal?: AbortSignal },
): Promise<void> | undefined {
  return preparation.getStore()?.()?.waitForAgentPreparation(agentId, options);
}

/** Wait before acquiring write/session authority; startup alone owns the completion and budget. */
export function waitForAgentDatabaseWriteAdmission(
  agentId: string,
  options: {
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    owner?: AgentDatabasePreparation;
  } = {},
): Promise<void> | undefined {
  const signals = [options.signal, getAsyncWorkSignal()].filter(
    (signal): signal is AbortSignal => signal !== undefined,
  );
  return (options.owner ?? preparation.getStore()?.())?.waitForAgentPreparation(agentId, {
    env: options.env,
    signal: signals.length ? AbortSignal.any(signals) : undefined,
    forWrite: true,
  });
}
