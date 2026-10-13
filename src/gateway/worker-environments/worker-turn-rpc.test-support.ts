import type { WorkerSessionTurnClaim } from "./placement-record.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import { advancePlacementFixtureToActive } from "./placement-test-fixtures.js";
import * as support from "./service.test-support.js";

export async function claimWorkerPlacement(params: {
  environmentId: string;
  ownerEpoch: number;
  runId?: string;
  sessionId: string;
}): Promise<{
  claim: WorkerSessionTurnClaim;
  store: ReturnType<typeof createWorkerSessionPlacementStore>;
}> {
  const store = createWorkerSessionPlacementStore({
    database: support.testState.stateDb,
    now: () => support.testState.nowMs,
  });
  const identity = {
    sessionId: params.sessionId,
    agentId: "main",
    sessionKey: `agent:main:${params.sessionId}`,
  };
  await advancePlacementFixtureToActive(store, support.testState.stateDb, identity, {
    environmentId: params.environmentId,
    ownerEpoch: params.ownerEpoch,
    workerBundleHash: support.BUNDLE_HASH,
    workspaceBaseManifestRef: `manifest-${params.sessionId}`,
    remoteWorkspaceDir: `/workspace/${params.sessionId}`,
    seedEnvironment: false,
  });
  const claim = await store.claimTurn({
    ...identity,
    claimId: `claim-${params.sessionId}`,
    runId: params.runId ?? "run-1",
    owner: {
      kind: "worker",
      environmentId: params.environmentId,
      ownerEpoch: params.ownerEpoch,
    },
  });
  return { claim, store };
}
