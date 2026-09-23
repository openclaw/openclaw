import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { WorkerConnectionIdentity } from "./worker-environments/connection-identity.js";
import { createWorkerLiveEventReceiver } from "./worker-environments/live-events.js";
import { captureWorkerTranscriptSource } from "./worker-environments/live-events.test-support.js";
import type { WorkerTranscriptCommitStore } from "./worker-environments/transcript-commit-store.js";
import { createWorkerTranscriptCommitter } from "./worker-environments/transcript-commit.js";

export function createWorkerFanoutFixture({
  storePath,
  sessionId,
  sessionKey,
}: {
  storePath: string;
  sessionId: string;
  sessionKey: string;
}) {
  const config: OpenClawConfig = {
    agents: { list: [{ id: "main", default: true }] },
    session: { mainKey: "main", store: storePath },
  };
  const ledger: WorkerTranscriptCommitStore = {
    begin: () => ({ kind: "claimed" }),
    complete: ({ outcome }) => outcome,
    discardUncommitted: () => {},
  };
  const committer = createWorkerTranscriptCommitter({ getConfig: () => config, store: ledger });
  const identity: WorkerConnectionIdentity = {
    environmentId: "environment-fanout",
    credentialHash: ["fanout", "credential", "hash"].join("-"),
    bundleHash: "f".repeat(64),
    sessionId,
    runId: "run-fanout",
    turnClaim: {
      sessionId,
      claimId: "claim-fanout",
      runId: "run-fanout",
      placementGeneration: 4,
      owner: { kind: "worker", environmentId: "environment-fanout", ownerEpoch: 4 },
    },
    ownerEpoch: 4,
    rpcSetVersion: 1,
    protocolFeatures: ["worker-live-event-v1", "worker-transcript-commit-v1"],
    credentialExpiresAtMs: Date.now() + 10_000,
  };
  const source = captureWorkerTranscriptSource({
    agentId: "main",
    sessionId,
    sessionKey,
    storePath,
  });
  const receiver = createWorkerLiveEventReceiver({
    startupBindings: [{ environmentId: identity.environmentId, runEpoch: 4, sessionId }],
    startupOwners: new Map([[identity.environmentId, 4]]),
  });
  return { committer, identity, receiver, sessionTarget: source.sessionTarget, source };
}
