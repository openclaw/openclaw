import path from "node:path";
import type { WorkerAdmissionHandshake } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { createOperationalRunInstanceRef } from "../../agents/admitted-run-context.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import type { WorkerConnectionIdentity } from "./connection-identity.js";
import type { WorkerSessionTurnClaim } from "./placement-record.js";
import { bindWorkerTurnOwner } from "./placement-turn-claim-events.js";
import { createWorkerSessionPlacementGate } from "./placement-worker-gate.js";
import * as support from "./service.test-support.js";
import { claimWorkerPlacement } from "./worker-turn-rpc.test-support.js";

export function turnRequests(
  identity: WorkerConnectionIdentity,
  service: ReturnType<typeof support.createService>,
) {
  return {
    transcript: (text: string, options?: Parameters<typeof support.transcriptRequest>[2]) =>
      service.commitTranscript(identity, support.transcriptRequest(identity, text, options)),
    terminal: (options?: Parameters<typeof support.terminalEvent>[1]) =>
      service.pushLiveEvent(identity, support.terminalEvent(identity, options)),
    assistant: (text: string, options?: Parameters<typeof support.assistantEvent>[2]) =>
      service.pushLiveEvent(identity, support.assistantEvent(identity, text, options)),
  };
}

type PlacementStore = Awaited<ReturnType<typeof claimWorkerPlacement>>["store"];
export function claimService(
  store: PlacementStore,
  options: Parameters<typeof support.createService>[1] = {},
) {
  return support.createService(support.createProvider(), {
    ...options,
    placementStore: createWorkerSessionPlacementGate(store),
  });
}

export function replaceClaim(
  store: PlacementStore,
  previous: WorkerSessionTurnClaim,
  claimId: string,
) {
  const placement = store.get(previous.sessionId)!;
  return store.claimTurn({
    sessionId: previous.sessionId,
    agentId: placement.agentId,
    sessionKey: placement.sessionKey,
    claimId,
    runId: previous.runId,
    owner: { ...previous.owner },
  });
}

export async function seedClaim(environmentId: string, sessionId: string, runId?: string) {
  const environmentIdentity = await support.seedAttachedIdentity(environmentId, sessionId);
  const placement = await claimWorkerPlacement({
    environmentId,
    sessionId,
    runId,
    ownerEpoch: environmentIdentity.ownerEpoch,
  });
  return { ...placement, environmentIdentity };
}

export function claimTarget(sessionId: string, file = "sessions.json") {
  return {
    agentId: "main",
    sessionId,
    sessionKey: `agent:main:${sessionId}`,
    storePath: path.join(support.testState.root, file),
  };
}

export function claimAdmission(
  claim: WorkerSessionTurnClaim,
  credential: string,
  handshake: WorkerAdmissionHandshake = support.BOOTSTRAP_RECEIPT,
) {
  if (claim.owner.kind !== "worker") {
    throw new Error("Expected a worker-owned fixture claim");
  }
  return {
    environmentId: claim.owner.environmentId,
    ownerEpoch: claim.owner.ownerEpoch,
    sessionId: claim.sessionId,
    runId: claim.runId,
    credential,
    rpcSetVersion: 1,
    handshake,
  };
}

type Bind = typeof bindWorkerTurnOwner;
export async function bindClaimOwner(
  store: Parameters<Bind>[0],
  claim: WorkerSessionTurnClaim,
  options: {
    token?: Parameters<Bind>[2];
    target?: Parameters<Bind>[4];
    assertCurrent?: Parameters<Bind>[5];
    prepare?: Parameters<Bind>[6];
    beforeBind?: (authority: ReturnType<typeof claimAgentRunDelegatedAuthority>) => void;
  } = {},
) {
  const instance = createOperationalRunInstanceRef(claim.runId);
  const authority = claimAgentRunDelegatedAuthority(instance);
  const release = () => releaseAgentRunDelegatedAuthority(authority);
  try {
    options.beforeBind?.(authority);
    await bindWorkerTurnOwner(
      store,
      claim,
      options.token,
      instance,
      options.target ?? claimTarget(claim.sessionId),
      options.assertCurrent ?? (() => {}),
      options.prepare,
    );
    return { release };
  } catch (error) {
    release();
    throw error;
  }
}
