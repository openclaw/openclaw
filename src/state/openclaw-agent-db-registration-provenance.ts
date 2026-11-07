import type { SessionRowChange } from "../sessions/session-row-changes.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { AgentDatabaseRegistryChange } from "./openclaw-agent-db-contract.js";
import type { AgentDatabaseRegistryMutation } from "./openclaw-agent-db-registry-listing.js";

export type AgentDatabaseRegistrationTransition = {
  operation: symbol;
  phase: "begin" | "commit" | "finish";
  mutation?: AgentDatabaseRegistryMutation;
};
const registrationChanges = resolveGlobalSingleton(
  Symbol.for("openclaw.agentDatabaseRegistrationChanges"),
  () => new WeakMap<AgentDatabaseRegistryChange, AgentDatabaseRegistrationTransition>(),
);
const registrationPublications = resolveGlobalSingleton(
  Symbol.for("openclaw.agentDatabaseRegistrationPublications"),
  () => new WeakMap<SessionRowChange, AgentDatabaseRegistryChange>(),
);

/** Neutral provenance from this registry owner, never a registration permission. */
export function readAgentDatabaseRegistrationChange(change: AgentDatabaseRegistryChange) {
  return registrationChanges.get(change);
}
export function readAgentDatabaseRegistrationPublication(change: SessionRowChange) {
  return registrationPublications.get(change);
}

export function recordAgentDatabaseRegistrationChange(
  change: AgentDatabaseRegistryChange,
  transition: AgentDatabaseRegistrationTransition,
): void {
  registrationChanges.set(change, transition);
}
export function recordAgentDatabaseRegistrationPublication(
  change: SessionRowChange,
  registration?: AgentDatabaseRegistryChange,
): void {
  if (registration && registrationChanges.has(registration)) {
    registrationPublications.set(change, registration);
  }
}
