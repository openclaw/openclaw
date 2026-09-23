import { createOperationalRunInstanceRef } from "../agents/admitted-run-context.js";
import type { BoundAgentRunSessionTarget } from "../agents/run-session-target.types.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import type { WorkerSessionTurnClaim } from "../gateway/worker-environments/placement-record.js";
import type { WorkerSessionPlacementStore } from "../gateway/worker-environments/placement-store.js";
import {
  bindWorkerTurnOwner,
  signalWorkerTurnClaimClosed,
} from "../gateway/worker-environments/placement-turn-claim-events.js";
import { resolveWorkerTurnTranscriptTarget } from "../gateway/worker-environments/worker-turn-transcript-target.js";
import {
  claimAgentRunDelegatedAuthority,
  registerAgentRunContext,
  releaseAgentRunDelegatedAuthority,
} from "../infra/agent-run-registry.js";

export function bindWorkerFixtureTurnSource(
  store: WorkerSessionPlacementStore,
  databasePath: string,
  claim: WorkerSessionTurnClaim,
  target: BoundAgentRunSessionTarget,
) {
  const entry = loadSessionEntry(target);
  if (!entry || entry.sessionId !== claim.sessionId) {
    throw new Error("fault worker source is missing");
  }
  const sessionTarget = {
    ...target,
    expectedLifecycleRevision: entry.lifecycleRevision,
    expectedWriterRunId: entry.activeWriterRunId,
  };
  const assertSourceCurrent = () => {
    resolveWorkerTurnTranscriptTarget({ ...sessionTarget, sessionTarget });
  };
  const operationalRunInstance = createOperationalRunInstanceRef(claim.runId);
  const authority = claimAgentRunDelegatedAuthority(operationalRunInstance, assertSourceCurrent);
  const dispose = () => {
    signalWorkerTurnClaimClosed(databasePath, claim);
    releaseAgentRunDelegatedAuthority(authority);
  };
  try {
    registerAgentRunContext(claim.runId, target, authority.claimId);
    bindWorkerTurnOwner(
      store,
      claim,
      undefined,
      operationalRunInstance,
      sessionTarget,
      assertSourceCurrent,
    );
  } catch (error) {
    dispose();
    throw error;
  }
  return { operationalRunInstance, dispose };
}
