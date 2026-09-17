import type { WorkerSessionPlacementRecord } from "./placement-store.js";

export function activePlacementRecord(): Extract<
  WorkerSessionPlacementRecord,
  { state: "active" }
> {
  return {
    sessionId: "sess-main",
    agentId: "main",
    sessionKey: "agent:main:main",
    executionMode: "worker-turn",
    state: "active",
    environmentId: "env-placement",
    generation: 7,
    activeOwnerEpoch: 12,
    workspaceBaseManifestRef: "manifest-base",
    remoteWorkspaceDir: "/workspace/main",
    workerBundleHash: ["a", "b"].join("").repeat(32),
    lastTranscriptAckCursor: 23,
    lastLiveEventAckCursor: 9,
    recoveryError: null,
    terminalReason: null,
    terminalAtMs: null,
    turnClaim: null,
    createdAtMs: 100,
    updatedAtMs: 300,
    stateChangedAtMs: 200,
  };
}
