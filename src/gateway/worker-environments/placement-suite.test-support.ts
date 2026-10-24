import { placementTurnOwner, type WorkerSessionPlacementRecord } from "./placement-record.js";

export function sessionIdentity(sessionId: string) {
  return { sessionId, sessionKey: `agent:main:${sessionId}`, agentId: "main" };
}

export function localPlacement(sessionId = "session-1") {
  return {
    ...sessionIdentity(sessionId),
    state: "local",
    executionMode: "worker-turn",
    generation: 1,
    turnClaim: null,
    environmentId: null,
    activeOwnerEpoch: null,
    workspaceBaseManifestRef: null,
    remoteWorkspaceDir: null,
    workerBundleHash: null,
    lastTranscriptAckCursor: null,
    lastLiveEventAckCursor: null,
    recoveryError: null,
    terminalReason: null,
    terminalAtMs: null,
    createdAtMs: 1,
    updatedAtMs: 1,
    stateChangedAtMs: 1,
  } satisfies WorkerSessionPlacementRecord;
}

type Active = Extract<WorkerSessionPlacementRecord, { state: "active" }>;
export function placementClaim(placement: Active, name: string) {
  return {
    sessionId: placement.sessionId,
    sessionKey: placement.sessionKey,
    agentId: placement.agentId,
    claimId: `${name}-claim`,
    runId: `${name}-run`,
    owner: placementTurnOwner(placement),
  };
}

export function placementSource(
  placement: Pick<Active, "generation" | "environmentId" | "activeOwnerEpoch">,
) {
  return {
    generation: placement.generation,
    environmentId: placement.environmentId,
    ownerEpoch: placement.activeOwnerEpoch,
  };
}

export function placementTransition(placement: Active) {
  return {
    sessionId: placement.sessionId,
    environmentId: placement.environmentId,
    ownerEpoch: placement.activeOwnerEpoch,
    expectedGeneration: placement.generation,
  };
}

export function activePlacement(sessionId: string, overrides: Partial<Active> = {}): Active {
  return {
    ...localPlacement(sessionId),
    state: "active",
    generation: 2,
    environmentId: `environment:${sessionId}`,
    activeOwnerEpoch: 3,
    workspaceBaseManifestRef: "manifest",
    remoteWorkspaceDir: "/workspace",
    workerBundleHash: "a".repeat(64),
    ...overrides,
  };
}
