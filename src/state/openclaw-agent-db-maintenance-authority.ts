import { AsyncLocalStorage } from "node:async_hooks";
import type { OpenClawStateLeaseContext } from "./openclaw-state-lease-context.js";

export const agentDatabaseMaintenanceAuthority = new AsyncLocalStorage<{
  authority: OpenClawStateLeaseContext;
  databasePath: string;
  assertScopeCurrent?: () => void;
}>();

export class AgentDatabaseMaintenanceRequiredError extends Error {
  override name = "AgentDatabaseMaintenanceRequiredError";
}

/** Revalidate the held lease, including immediately before committing a versioned rebuild. */
export function assertAgentDatabaseMaintenanceAuthority(
  expected?: OpenClawStateLeaseContext,
): void {
  const authority = agentDatabaseMaintenanceAuthority.getStore()?.authority;
  if (!authority || (expected && authority !== expected)) {
    const ErrorType = authority ? Error : AgentDatabaseMaintenanceRequiredError;
    throw new ErrorType(
      "Agent database migration requires stopped-writer maintenance; stop active agents and run openclaw doctor --fix.",
    );
  }
  authority.assertOwned();
  agentDatabaseMaintenanceAuthority.getStore()?.assertScopeCurrent?.();
}
