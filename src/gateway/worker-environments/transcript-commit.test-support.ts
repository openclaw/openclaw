import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { WorkerConnectionIdentity } from "./connection-identity.js";
import type { WorkerTranscriptCommitStore } from "./transcript-commit-ledger.js";
import { createWorkerTranscriptCommitter } from "./transcript-commit.js";

export function createTranscriptCommitIdentity(
  sessionId: string,
  ownerEpoch: number,
): WorkerConnectionIdentity {
  return {
    environmentId: "environment-a",
    credentialHash: ["credential", "hash", "a"].join("-"),
    bundleHash: "b".repeat(64),
    sessionId,
    runId: "run-worker-transcript",
    turnClaim: {
      sessionId,
      claimId: "claim-worker-transcript",
      runId: "run-worker-transcript",
      placementGeneration: 4,
      owner: { kind: "worker", environmentId: "environment-a", ownerEpoch },
    },
    ownerEpoch,
    rpcSetVersion: 1,
    protocolFeatures: ["worker-transcript-commit-v1"],
    credentialExpiresAtMs: 10_000,
  };
}

export function createInterruptedCommitter(
  getConfig: () => OpenClawConfig,
  store: WorkerTranscriptCommitStore,
  message: string,
) {
  let interruptCompletion = true;
  return createWorkerTranscriptCommitter({
    getConfig,
    store: {
      ...store,
      complete: (input, assertCurrent) => {
        if (interruptCompletion) {
          interruptCompletion = false;
          throw new Error(message);
        }
        return store.complete(input, assertCurrent);
      },
    },
  });
}
