import { AsyncLocalStorage } from "node:async_hooks";
import { getAsyncWorkSignal } from "../shared/async-work-scope.js";

export type AgentInputRecoveryAdmission = {
  isPending: (agentId: string) => boolean;
  waitForAgentInputRecovery: (
    agentId: string,
    options?: { signal?: AbortSignal },
  ) => Promise<void> | undefined;
};

const recovery = new AsyncLocalStorage<() => AgentInputRecoveryAdmission | undefined>();

export function withAgentInputRecoveryContext<T>(
  resolveOwner: () => AgentInputRecoveryAdmission | undefined,
  run: () => T,
): T {
  return recovery.run(resolveOwner, run);
}

export function isAgentInputRecoveryPending(agentId: string): boolean {
  return recovery.getStore()?.()?.isPending(agentId) ?? false;
}

/** Fresh sources wait before reservation; recovery itself never borrows this gate. */
export function waitForAgentInputRecovery(
  agentId: string,
  options: { signal?: AbortSignal; owner?: AgentInputRecoveryAdmission } = {},
): Promise<void> | undefined {
  const signals = [options.signal, getAsyncWorkSignal()].filter(
    (signal): signal is AbortSignal => signal !== undefined,
  );
  return (options.owner ?? recovery.getStore()?.())?.waitForAgentInputRecovery(agentId, {
    signal: signals.length ? AbortSignal.any(signals) : undefined,
  });
}
