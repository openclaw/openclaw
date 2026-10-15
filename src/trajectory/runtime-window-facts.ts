import {
  sessionChanges,
  sessionChangeScopeAffectsStoredRows,
} from "../sessions/session-row-changes.js";
import type { AgentDatabaseExecutionFileIdentity } from "../state/openclaw-agent-execution-contract.js";
import type { TrajectoryRuntimeWindowFacts } from "./runtime-store.contract.js";

// One recent session per physical owner; switching sessions simply reloads the SQL window.
let windows = new WeakMap<
  AgentDatabaseExecutionFileIdentity,
  { sessionId: string; facts: TrajectoryRuntimeWindowFacts }
>();

sessionChanges.subscribeFacts((change) => {
  if (!sessionChangeScopeAffectsStoredRows(change)) {
    return;
  }
  if ("sessionKey" in change && !change.factsInvalidated) {
    // Transcript and metadata receipts do not remove trajectory rows. Reclamation
    // publishes removal or unknown row facts before releasing the writer FIFO.
    if (change.scope === "transcript") {
      return;
    }
    const facts = change.facts;
    if (
      facts &&
      facts.kind !== "removed" &&
      (facts.kind !== "entry" ||
        (facts.previousSessionId === facts.sessionId && !facts.lifecycleChanged)) &&
      (facts.kind !== "replacement" || facts.lifecycleChanged === false)
    ) {
      return;
    }
  }
  windows = new WeakMap();
});

/** Consume before awaiting a write; an unknown append outcome must leave the next read cold. */
export function takeTrajectoryRuntimeWindowFacts(
  identity: AgentDatabaseExecutionFileIdentity,
  sessionId: string,
): TrajectoryRuntimeWindowFacts | undefined {
  const window = windows.get(identity);
  windows.delete(identity);
  return window?.sessionId === sessionId ? window.facts : undefined;
}

export function publishTrajectoryRuntimeWindowFacts(
  identity: AgentDatabaseExecutionFileIdentity,
  sessionId: string,
  facts: TrajectoryRuntimeWindowFacts,
): void {
  windows.set(identity, { sessionId, facts });
}

export function invalidateTrajectoryRuntimeWindowFacts(
  identity: AgentDatabaseExecutionFileIdentity,
): void {
  windows.delete(identity);
}
