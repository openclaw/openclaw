import type { WorkerLiveEventParams } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { releaseAgentRunContext } from "../../infra/agent-run-registry.js";
import {
  isDefinitiveWorkerTerminalEvent,
  type WorkerLiveTrajectoryRecorder,
} from "./live-event-projection.js";
import type { WorkerTurnTranscriptSource } from "./placement-turn-claim-events.js";
import type { WorkerTurnLiveEventOwner } from "./worker-turn-run-owner.js";

export type PendingLiveEvent = {
  request: WorkerLiveEventParams;
  sizeBytes: number;
  recordApplied?: (event: WorkerLiveEventParams["event"]) => void;
  runOwner?: WorkerTurnLiveEventOwner;
  source: WorkerTurnTranscriptSource;
};

export type OwnedLiveRun = {
  claimId: string;
  controlUiVisible: boolean;
  emissionMode: "exclusive" | "shared";
  lifecycleGeneration: string;
  trajectoryRecorder: WorkerLiveTrajectoryRecorder;
  toolArgsByCallId: Map<string, unknown>;
};

export type WorkerLiveCredentialRotation = Readonly<
  {
    credentialHash: string;
    environmentId: string;
    previousCredentialHash: string;
    runEpoch: number;
    sessionId: string;
  } & ({ newProcessTurn: true; ackedSeq: number } | { newProcessTurn?: false })
>;

export type LiveEventWindow = {
  activeApplications: number;
  activeRuns: Map<string, OwnedLiveRun>;
  ackedSeq: number;
  credentialHash: string;
  environmentId: string;
  pending: Map<number, PendingLiveEvent>;
  pendingBytes: number;
  trajectoryWrites: Set<Promise<void>>;
  runEpoch: number;
  sessionId: string;
  source: WorkerTurnTranscriptSource;
  terminalRuns: Map<string, number>;
};

export function releaseWorkerLiveRun(window: LiveEventWindow, runId: string): void {
  const owned = window.activeRuns.get(runId);
  if (!owned) {
    return;
  }
  window.activeRuns.delete(runId);
  releaseAgentRunContext(runId, owned.claimId);
}

export function fenceReleasedWorkerLiveRun(window: LiveEventWindow, runId: string): void {
  if (!window.terminalRuns.has(runId)) {
    window.terminalRuns.set(runId, window.ackedSeq);
  }
  releaseWorkerLiveRun(window, runId);
}

export function hasReachableBufferedTerminal(
  window: LiveEventWindow,
  admittedRunId: string,
  countedRunIds: ReadonlySet<string>,
  windowSize: number,
): boolean {
  // Borrow one source-ended slot only when this ordered drain can reach that
  // active run's terminal without claiming another new run first.
  for (let seq = window.ackedSeq + 2; seq <= window.ackedSeq + windowSize; seq += 1) {
    const pending = window.pending.get(seq);
    if (!pending) {
      return false;
    }
    const pendingRunId = pending.request.runId;
    if (countedRunIds.has(pendingRunId)) {
      if (isDefinitiveWorkerTerminalEvent(pending.request.event)) {
        return true;
      }
      continue;
    }
    if (pendingRunId !== admittedRunId) {
      // Another new run would consume the borrowed slot before the terminal.
      return false;
    }
  }
  return false;
}

// Durable credential renewal keeps the same owner epoch and replay cursor.
export function rotateWorkerLiveEventCredential(
  window: LiveEventWindow | undefined,
  rotation: WorkerLiveCredentialRotation,
): boolean {
  if (
    !rotation.credentialHash ||
    !rotation.environmentId ||
    !rotation.previousCredentialHash ||
    !rotation.sessionId ||
    !Number.isSafeInteger(rotation.runEpoch) ||
    rotation.runEpoch < 0
  ) {
    return false;
  }
  if (
    window?.credentialHash === rotation.previousCredentialHash &&
    window.environmentId === rotation.environmentId &&
    window.runEpoch === rotation.runEpoch
  ) {
    if (rotation.newProcessTurn === true) {
      if (
        !Number.isSafeInteger(rotation.ackedSeq) ||
        rotation.ackedSeq < 0 ||
        rotation.ackedSeq > window.ackedSeq
      ) {
        return false;
      }
      // A per-turn credential is an unforgeable process boundary. Retire only
      // the prior process's transient state and rewind previews to the durable
      // ACK cursor; cron may intentionally reuse its durable run id.
      for (const [runId, owned] of window.activeRuns) {
        releaseAgentRunContext(runId, owned.claimId);
      }
      window.activeRuns.clear();
      window.ackedSeq = rotation.ackedSeq;
      window.pending.clear();
      window.pendingBytes = 0;
      window.terminalRuns.clear();
    }
    window.credentialHash = rotation.credentialHash;
    return true;
  }
  return false;
}
