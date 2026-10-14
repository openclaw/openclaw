import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { getAgentRunRegistryState } from "./agent-run-registry-state.js";

/** Observe execution ownership, including queued turns, without reading storage. */
export function observeAgentRunActivity(
  agentId: string,
  listener: (busy: boolean) => void,
): () => void {
  const target = normalizeAgentId(agentId);
  let previous: boolean | undefined;
  const publish = () => {
    const state = getAgentRunRegistryState();
    let busy = false;
    for (const [runId, context] of state.contexts) {
      const owner =
        context.agentId ??
        (context.sessionKey && parseAgentSessionKey(context.sessionKey)?.agentId);
      if (
        context.lifecycleGeneration !== state.lifecycleGeneration ||
        !owner ||
        normalizeAgentId(owner) !== target
      ) {
        continue;
      }
      const owners = state.owners.get(runId);
      if (
        (owners?.lifecycleGeneration === state.lifecycleGeneration && owners.claimIds.size > 0) ||
        (state.queuedRunContextLeases?.get(context) ?? 0) > 0
      ) {
        busy = true;
        break;
      }
    }
    if (busy !== previous) {
      previous = busy;
      listener(busy);
    }
  };
  const unsubscribe = sessionChanges.subscribe((change) => {
    if (
      ("all" in change && change.scope === "agent-runs") ||
      (!("all" in change) && change.scope === "runtime")
    ) {
      publish();
    }
  });
  publish();
  return unsubscribe;
}
