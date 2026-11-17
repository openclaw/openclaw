import {
  sessionChanges,
  sessionChangeScopeAffectsStoredRows,
} from "../sessions/session-row-changes.js";
import type { AgentDatabaseExecutionFileIdentity } from "../state/openclaw-agent-execution-contract.js";
import type { TrajectoryRuntimeWindowFacts } from "./runtime-store.contract.js";

// Bound idle facts per physical owner without evicting concurrent sessions on every append.
const MAX_RETAINED_WINDOWS = 64;
let windows = new WeakMap<
  AgentDatabaseExecutionFileIdentity,
  Map<string, TrajectoryRuntimeWindowFacts>
>();

sessionChanges.subscribeFacts((change) => {
  if (!sessionChangeScopeAffectsStoredRows(change)) {
    return;
  }
  if ("sessionKey" in change && !change.factsInvalidated) {
    // Transcript and metadata receipts do not remove trajectory rows. Reclamation
    // publishes removal or unknown row facts before releasing the writer FIFO.
    if (!change.facts || change.scope === "transcript") {
      return;
    }
    const facts = change.facts;
    if (
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
  const retained = windows.get(identity);
  const facts = retained?.get(sessionId);
  retained?.delete(sessionId);
  return facts;
}

export function publishTrajectoryRuntimeWindowFacts(
  identity: AgentDatabaseExecutionFileIdentity,
  sessionId: string,
  facts: TrajectoryRuntimeWindowFacts,
): void {
  let retained = windows.get(identity);
  if (!retained) {
    retained = new Map();
    windows.set(identity, retained);
  }
  retained.set(sessionId, facts);
  if (retained.size > MAX_RETAINED_WINDOWS) {
    retained.delete(retained.keys().next().value!);
  }
}

export function invalidateTrajectoryRuntimeWindowFacts(
  identity: AgentDatabaseExecutionFileIdentity,
): void {
  windows.delete(identity);
}
