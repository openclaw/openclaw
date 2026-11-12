// Canonical process-local registry state; callers retain the existing singleton identity.
import { randomUUID } from "node:crypto";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { buildAgentRunProjectionIndex, projectedRunIdentity } from "./agent-run-projection.js";
import type {
  AgentRunContext,
  AgentRunContextOwnership,
  AgentRunRegistryState,
  ProjectedAgentRunIndex,
} from "./agent-run-registry.types.js";

const AGENT_RUN_REGISTRY_STATE_KEY = Symbol.for("openclaw.agentRunRegistry.state");

const registryState = resolveGlobalSingleton<AgentRunRegistryState>(
  AGENT_RUN_REGISTRY_STATE_KEY,
  () => ({
    contexts: new Map<string, AgentRunContext>(),
    owners: new Map<string, AgentRunContextOwnership>(),
    lifecycleGeneration: randomUUID(),
    version: 0,
  }),
);

export function getAgentRunRegistryState(): AgentRunRegistryState {
  return registryState;
}

/** Reads the process-local version of the active-run projection inputs. */
export function readAgentRunIndexVersion(): number {
  return registryState.version;
}

export function getAgentRunLifecycleGeneration(): string {
  return registryState.lifecycleGeneration;
}

/** Lists registered runs bound to one current session identity. */
export function listAgentRunsForSession(params: {
  sessionKey: string;
  sessionId?: string;
}): Array<{ runId: string; lifecycleGeneration: string }> {
  const state = getAgentRunRegistryState();
  const runs: Array<{ runId: string; lifecycleGeneration: string }> = [];
  for (const [runId, context] of state.contexts) {
    const matches =
      context.sessionKey === params.sessionKey &&
      (!context.sessionId || context.sessionId === params.sessionId);
    if (matches && context.lifecycleGeneration === state.lifecycleGeneration) {
      runs.push({ runId, lifecycleGeneration: context.lifecycleGeneration });
    }
  }
  return runs.toSorted((a, b) => a.runId.localeCompare(b.runId));
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
  (previous.sessionKey !== context?.sessionKey ||
    (!previous.sessionKey && previous.sessionId !== context?.sessionId) ||
    previous.agentId !== context?.agentId)
    ? [previous, context]
    : [context]) {
    const { sessionKey, sessionId, agentId } = target ?? {};
    sessionChanges.emit(
      sessionKey
        ? { sessionKey, agentId, scope: "runtime" }
        : {
            all: true,
            scope: "agent-runs",
            ...(sessionId ? { runtimeSession: { sessionId, agentId } } : {}),
          },
    );
  }
}

/** Snapshot native execution observations alongside the existing foreground run index. */
export function buildProjectedAgentRunIndex(): ProjectedAgentRunIndex {
  const { contexts, lifecycleGeneration, subagentActivities } = getAgentRunRegistryState();
  const index = new Map<string, Set<string>>();
  for (const activity of subagentActivities?.values() ?? []) {
    if (activity.lifecycleGeneration !== lifecycleGeneration) {
      continue;
    }
    const key = projectedRunIdentity(activity.agentId, activity.sessionKey);
    const sessions = index.get(key) ?? new Set<string>();
    sessions.add(JSON.stringify([activity.sessionId, activity.lifecycleRevision ?? null]));
    index.set(key, sessions);
  }
  return {
    ...buildAgentRunProjectionIndex({ contexts: contexts.values(), lifecycleGeneration }),
    subagentSessionKeys: index,
  };
}

/** Projects an observed native child without registering an abortable parent execution. */
export function retainAgentRunSubagentActivity(params: {
  sessionKey: string;
  sessionId: string;
  lifecycleRevision?: string;
  agentId: string;
}): () => void {
  const state = getAgentRunRegistryState();
  const activities = (state.subagentActivities ??= new Map());
  const token = Symbol("native child activity");
  activities.set(token, { ...params, lifecycleGeneration: state.lifecycleGeneration });
  bumpAgentRunIndexVersion(params);
  return () => {
    if (activities.delete(token)) {
      bumpAgentRunIndexVersion(params);
    }
  };
}
