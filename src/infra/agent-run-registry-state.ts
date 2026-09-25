// Canonical process-local registry state; callers retain the existing singleton identity.
import { randomUUID } from "node:crypto";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type {
  AgentRunContext,
  AgentRunContextOwnership,
  AgentRunRegistryState,
} from "./agent-run-registry.types.js";

const AGENT_RUN_REGISTRY_STATE_KEY = Symbol.for("openclaw.agentRunRegistry.state");

export function getAgentRunRegistryState(): AgentRunRegistryState {
  return resolveGlobalSingleton<AgentRunRegistryState>(AGENT_RUN_REGISTRY_STATE_KEY, () => ({
    contexts: new Map<string, AgentRunContext>(),
    owners: new Map<string, AgentRunContextOwnership>(),
    lifecycleGeneration: randomUUID(),
    version: 0,
  }));
}

export function getAgentRunContextOwnerStatus(
  runId: string,
  claimId: string,
  lifecycleGeneration: string,
): "active" | "clear-requested" | undefined {
  const state = getAgentRunRegistryState();
  const owners = state.owners.get(runId);
  if (
    lifecycleGeneration !== state.lifecycleGeneration ||
    owners?.lifecycleGeneration !== lifecycleGeneration ||
    !owners.claimIds.has(claimId)
  ) {
    return undefined;
  }
  return owners.clearRequested ? "clear-requested" : "active";
}

export function bumpAgentRunIndexVersion(
  context?: AgentRunContext,
  previous?: AgentRunContext,
): void {
  getAgentRunRegistryState().version += 1;
  for (const target of previous &&
  (previous.sessionKey !== context?.sessionKey || previous.agentId !== context?.agentId)
    ? [previous, context]
    : [context]) {
    const { sessionKey, agentId } = target ?? {};
    sessionChanges.emit(
      sessionKey ? { sessionKey, agentId, scope: "runtime" } : { all: true, scope: "agent-runs" },
    );
  }
}
