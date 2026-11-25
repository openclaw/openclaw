import { hashWorkerCredential } from "../gateway/worker-environments/credential.js";
import type { WorkerLiveEventReceiver } from "../gateway/worker-environments/live-events.js";
import {
  projectWorkerSessionTurnClaim,
  type WorkerSessionTurnClaim,
} from "../gateway/worker-environments/placement-record.js";
import type {
  WorkerSessionPlacementRecord,
  WorkerSessionPlacementStore,
} from "../gateway/worker-environments/placement-store.js";
import type {
  WorkerEnvironmentRecord,
  WorkerEnvironmentStore,
} from "../gateway/worker-environments/store.js";

export async function seedFaultAttachedEnvironment(
  store: WorkerEnvironmentStore,
  params: {
    environmentId: string;
    sessionId: string;
    credential: string;
    sshEndpoint: NonNullable<WorkerEnvironmentRecord["sshEndpoint"]>;
    handshake: NonNullable<WorkerEnvironmentRecord["bootstrapReceipt"]>;
    rpcSetVersion: number;
  },
): Promise<void> {
  const { environmentId, sessionId, credential, sshEndpoint, handshake, rpcSetVersion } = params;
  const makeCredential = (value: string, boundSessionId: string | null) => ({
    credentialHash: hashWorkerCredential(value),
    sessionId: boundSessionId,
    rpcSetVersion,
    expiresAtMs: Date.now() + 60_000,
  });
  let environment = await store.createIntent({
    environmentId,
    providerId: "fake",
    profileId: "development",
    profileSnapshot: { settings: { region: "test" } },
    provisionOperationId: "provision:fault-environment",
  });
  const transitions = [
    { to: "provisioning", patch: {} },
    { to: "bootstrapping", patch: { leaseId: "lease-fault", sshEndpoint } },
    {
      to: "ready",
      patch: {
        bootstrapReceipt: handshake,
        credential: makeCredential(`${credential}-ready`, null),
      },
    },
    {
      to: "attached",
      patch: {
        attachedSessionIds: [sessionId],
        credential: makeCredential(credential, sessionId),
      },
    },
  ] as const;
  for (const transition of transitions) {
    environment = await store.transition({
      environmentId,
      from: environment.state,
      ...transition,
    });
  }
}

type WorkerFaultPlacementLifecycleOptions = {
  agentId: string;
  bundleHash: string;
  environmentId: string;
  environmentStore: WorkerEnvironmentStore;
  getLiveEvents: () => Pick<WorkerLiveEventReceiver, "rotateCredential">;
  getOwnerEpoch: () => number;
  placementStore: WorkerSessionPlacementStore;
  rpcSetVersion: number;
  sessionId: string;
  sessionKey: string;
};

export class WorkerFaultPlacementLifecycle {
  private claimSequence = 0;

  constructor(private readonly options: WorkerFaultPlacementLifecycleOptions) {}

  async prepareRun(runId: string, credential: string): Promise<WorkerSessionTurnClaim> {
    const { placementStore, sessionId } = this.options;
    const current = await placementStore.getAsync(sessionId);
    const placement = current?.state === "active" ? current : await this.activatePlacement();
    let claim = projectWorkerSessionTurnClaim(placement);
    if (claim && claim.runId !== runId) {
      throw new Error(`fault placement is already claimed by ${claim.runId}`);
    }
    claim ??= await placementStore.claimTurn({
      sessionId,
      agentId: this.options.agentId,
      sessionKey: this.options.sessionKey,
      claimId: `claim:${runId}:${++this.claimSequence}`,
      runId,
      owner: {
        kind: "worker",
        environmentId: this.options.environmentId,
        ownerEpoch: this.options.getOwnerEpoch(),
      },
    });
    await this.bindCredentialToClaim(credential, claim);
    return claim;
  }

  async settleRun(runId: string): Promise<void> {
    const { placementStore, sessionId } = this.options;
    const placement = placementStore.get(sessionId);
    const claim = placement ? projectWorkerSessionTurnClaim(placement) : undefined;
    if (!claim || claim.runId !== runId) {
      throw new Error(`fault run ${runId} does not own the active placement`);
    }
    const pending = (await placementStore.listPendingWorkspaceResultsAsync()).some(
      (result) =>
        result.sessionId === claim.sessionId &&
        result.claimId === claim.claimId &&
        result.runId === claim.runId,
    );
    if (pending) {
      await placementStore.acceptWorkspaceResult(claim);
      await placementStore.completeWorkspaceResultAndReleaseTurn(claim);
      return;
    }
    await placementStore.releaseTurn(claim);
  }

  async reclaimPlacement(
    placement: Extract<WorkerSessionPlacementRecord, { state: "active" }>,
    ownerEpoch: number,
  ): Promise<void> {
    const { placementStore, environmentId } = this.options;
    let current: WorkerSessionPlacementRecord = placement;
    for (const [method, state, label] of [
      ["startDrain", "draining", "draining"],
      ["startReconcile", "reconciling", "reconciliation"],
    ] as const) {
      current = await placementStore[method]({
        sessionId: placement.sessionId,
        environmentId,
        ownerEpoch,
        expectedGeneration: current.generation,
      });
      if (current.state !== state) {
        throw new Error(`fault placement did not enter ${label}`);
      }
    }
    const reclaimed = await placementStore.transition({
      sessionId: placement.sessionId,
      from: "reconciling",
      to: "reclaimed",
      expectedGeneration: current.generation,
    });
    if (reclaimed.state !== "reclaimed") {
      throw new Error("fault placement did not finish reclaimed");
    }
  }

  private async activatePlacement(): Promise<
    Extract<WorkerSessionPlacementRecord, { state: "active" }>
  > {
    const { placementStore, sessionId } = this.options;
    let placement = await placementStore.startDispatch({
      sessionId,
      agentId: this.options.agentId,
      sessionKey: this.options.sessionKey,
    });
    const transitions = [
      { to: "provisioning", patch: { environmentId: this.options.environmentId } },
      { to: "syncing", patch: { workerBundleHash: this.options.bundleHash } },
      {
        to: "starting",
        patch: {
          workspaceBaseManifestRef: `sha256:${"c".repeat(64)}`,
          remoteWorkspaceDir: `/workspace/${sessionId}`,
        },
      },
      { to: "active", patch: { activeOwnerEpoch: this.options.getOwnerEpoch() } },
    ] as const;
    for (const transition of transitions) {
      placement = await placementStore.transition({
        sessionId,
        from: placement.state,
        expectedGeneration: placement.generation,
        ...transition,
      });
    }
    if (placement.state !== "active") {
      throw new Error("fault placement activation failed");
    }
    return placement;
  }

  private async bindCredentialToClaim(
    credential: string,
    claim: WorkerSessionTurnClaim,
  ): Promise<void> {
    const { placementStore, environmentStore, environmentId, sessionId } = this.options;
    if (claim.owner.kind !== "worker" || !placementStore.validateTurnClaim(claim)) {
      throw new Error("fault worker credential requires a worker-owned claim");
    }
    const previous = environmentStore.getCredential(environmentId);
    const credentialHash = hashWorkerCredential(credential, claim);
    await environmentStore.renewCredential({
      environmentId,
      expectedOwnerEpoch: claim.owner.ownerEpoch,
      credentialHash,
      sessionId,
      rpcSetVersion: this.options.rpcSetVersion,
      expiresAtMs: Date.now() + 60_000,
    });
    if (previous && previous.credentialHash !== credentialHash) {
      this.options.getLiveEvents().rotateCredential({
        ackedSeq: placementStore.get(sessionId)?.lastLiveEventAckCursor ?? 0,
        credentialHash,
        environmentId,
        newProcessTurn: true,
        previousCredentialHash: previous.credentialHash,
        runEpoch: claim.owner.ownerEpoch,
        sessionId,
      });
    }
  }
}
