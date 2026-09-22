import type { WorkerLiveEventParams } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { releaseAgentRunContext } from "../../infra/agent-run-registry.js";
import type { WorkerLiveTrajectoryRecorder } from "./live-event-projection.js";
import type { LiveEventTarget } from "./live-event-session-binding.js";

export type PendingLiveEvent = {
  request: WorkerLiveEventParams;
  sizeBytes: number;
  recordApplied?: (event: WorkerLiveEventParams["event"]) => void;
};

export type OwnedLiveRun = {
  claimId: string;
  controlUiVisible: boolean;
  emissionMode: "exclusive" | "shared";
  lifecycleGeneration: string;
  trajectoryRecorder: WorkerLiveTrajectoryRecorder;
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
  target: LiveEventTarget;
  terminalRuns: Map<string, number>;
};

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
