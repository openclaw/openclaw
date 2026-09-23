import { createOperationalRunInstanceRef } from "../agents/admitted-run-context.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import type { WorkerSessionTurnClaim } from "../gateway/worker-environments/placement-record.js";
import type { WorkerSessionPlacementStore } from "../gateway/worker-environments/placement-store.js";
import {
  bindWorkerTurnOwner,
  signalWorkerTurnClaimClosed,
} from "../gateway/worker-environments/placement-turn-claim-events.js";
import {
  resolveWorkerTurnTranscriptTarget,
  type WorkerTurnTranscriptTarget,
} from "../gateway/worker-environments/worker-turn-transcript-target.js";
import {
  claimAgentRunContext,
  claimAgentRunDelegatedAuthority,
  releaseAgentRunContext,
  releaseAgentRunDelegatedAuthority,
} from "../infra/agent-run-registry.js";

export function bindWorkerFixtureTurnSource(
  store: WorkerSessionPlacementStore,
  databasePath: string,
  claim: WorkerSessionTurnClaim,
  target: WorkerTurnTranscriptTarget,
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
  const runOwner = claimAgentRunContext(claim.runId, target, {
    ownsContext: true,
    trackOwner: true,
  });
  if (!runOwner) {
    throw new Error("fault worker run owner was not admitted");
  }
  const operationalRunInstance = createOperationalRunInstanceRef(claim.runId);
  const authority = claimAgentRunDelegatedAuthority(operationalRunInstance, assertSourceCurrent);
  const dispose = () => {
    signalWorkerTurnClaimClosed(databasePath, claim);
    releaseAgentRunDelegatedAuthority(authority);
    releaseAgentRunContext(claim.runId, runOwner);
  };
  try {
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
