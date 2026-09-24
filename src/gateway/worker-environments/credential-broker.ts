import {
  type WorkerAdmissionHandshake,
  WORKER_RPC_SET_VERSION,
} from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { sameWorkerBuild } from "../../worker/worker-build-identity.js";
import { StaleWorkerBuildError, type ExpectedWorkerBuild } from "./admission.js";
import type { WorkerInstallationArtifact } from "./bundle.js";
import {
  createWorkerCredentialMaterial,
  hashWorkerCredential,
  WORKER_CREDENTIAL_TTL_MS,
  type MintedWorkerCredential,
  type WorkerCredentialBinding,
} from "./credential.js";
import type { WorkerLiveEventReceiver } from "./live-events.js";
import type { WorkerSessionTurnClaim } from "./placement-record.js";
import type { WorkerSessionPlacementGate } from "./placement-worker-gate.js";
import { WorkerSessionAlreadyAttachedError } from "./session-attachment.js";
import type { WorkerEnvironmentState } from "./state.js";
import type {
  PreparedEnvironmentPlacementBinding,
  WorkerEnvironmentRecord,
  WorkerEnvironmentStore,
  WorkerEnvironmentTransitionPatch,
} from "./store.js";
import type { WorkerTunnelManager } from "./tunnel.js";

type WorkerCredentialBrokerOptions = {
  store: WorkerEnvironmentStore;
  prepareInstallation: (
    install: WorkerInstallationArtifact["install"],
  ) => Promise<WorkerInstallationArtifact>;
  tunnelManager?: Pick<WorkerTunnelManager, "stop">;
  workerCredentialTtlMs?: number;
  generateWorkerCredential?: (bytes: number) => string;
  liveEvents?: Pick<WorkerLiveEventReceiver, "rotateCredential">;
  placementStore?: WorkerSessionPlacementGate;
  now: () => number;
  isStopping: () => boolean;
  cancelInferenceEnvironment: (environmentId: string) => void;
  inState: (record: WorkerEnvironmentRecord, ...states: WorkerEnvironmentState[]) => boolean;
  move: (
    record: WorkerEnvironmentRecord,
    to: WorkerEnvironmentState,
    patch?: Parameters<WorkerEnvironmentStore["transition"]>[0]["patch"],
    assertCurrent?: () => void,
  ) => Promise<WorkerEnvironmentRecord>;
  serviceError: (code: "environment_not_found" | "invalid_state", message: string) => Error;
  withLock: <T>(environmentId: string, task: () => Promise<T>) => Promise<T>;
};

export function createWorkerCredentialBroker(options: WorkerCredentialBrokerOptions) {
  const { store } = options;
  const tunnels = options.tunnelManager;
  const now = options.now;
  const inState = options.inState;
  const move = options.move;
  const serviceError = options.serviceError;
  const withLock = options.withLock;
  const pendingCredentials = new Map<string, MintedWorkerCredential>();

  const credentialExpiry = () => {
    const ttlMs = options.workerCredentialTtlMs ?? WORKER_CREDENTIAL_TTL_MS;
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) {
      throw serviceError("invalid_state", "Worker credential lifetime is invalid");
    }
    const expiresAtMs = now() + ttlMs;
    if (!Number.isSafeInteger(expiresAtMs)) {
      throw serviceError("invalid_state", "Worker credential expiry is out of range");
    }
    return expiresAtMs;
  };

  const credentialMaterial = (claim?: WorkerSessionTurnClaim) =>
    createWorkerCredentialMaterial(options.generateWorkerCredential, claim);

  const grantFrom = (params: {
    credential: string;
    record: ReturnType<WorkerEnvironmentStore["getCredential"]>;
    claim?: WorkerSessionTurnClaim;
  }): MintedWorkerCredential => {
    const record = params.record;
    if (!record) {
      throw serviceError("invalid_state", "Worker credential persistence failed");
    }
    return {
      credential: params.credential,
      deliveryId: record.credentialHash,
      environmentId: record.environmentId,
      bundleHash: record.bundleHash,
      sessionId: record.sessionId,
      rpcSetVersion: record.rpcSetVersion,
      ownerEpoch: record.ownerEpoch,
      expiresAtMs: record.expiresAtMs,
      ...(params.claim ? { turnClaim: params.claim } : {}),
    };
  };

  const mintCredentialLocked = async (
    request: WorkerCredentialBinding,
    claim?: WorkerSessionTurnClaim,
  ): Promise<{ credentialHash: string; grant: MintedWorkerCredential }> => {
    const previous = store.getCredential(request.environmentId);
    if (previous) {
      options.cancelInferenceEnvironment(request.environmentId);
    }
    const material = credentialMaterial(claim);
    const credential = {
      environmentId: request.environmentId,
      expectedOwnerEpoch: request.ownerEpoch,
      credentialHash: material.credentialHash,
      sessionId: request.sessionId,
      rpcSetVersion: WORKER_RPC_SET_VERSION,
      expiresAtMs: credentialExpiry(),
      ...(claim
        ? {
            assertCurrent: () => {
              if (!validateTurnClaim(claim)) {
                throw serviceError(
                  "invalid_state",
                  "Worker turn credential claim is not authoritative",
                );
              }
            },
          }
        : {}),
    };
    const record = await store.renewCredential(credential);
    credential.assertCurrent?.();
    return {
      credentialHash: material.credentialHash,
      grant: grantFrom({ credential: material.credential, record, claim }),
    };
  };

  const stageCredential = (grant: MintedWorkerCredential): MintedWorkerCredential => {
    pendingCredentials.set(grant.environmentId, grant);
    return grant;
  };

  const commitReady = async (
    record: WorkerEnvironmentRecord,
    receipt: WorkerAdmissionHandshake & { installKind: "bundle" },
    patch: WorkerEnvironmentTransitionPatch = {},
    assertCurrent?: () => void,
  ) => {
    const material = credentialMaterial();
    // Receipt, owner epoch, and credential hash commit together. A failed write leaves the
    // durable lease retryable without ever admitting a partial identity.
    const ready = await move(
      record,
      "ready",
      {
        ...patch,
        bootstrapReceipt: receipt,
        credential: {
          credentialHash: material.credentialHash,
          sessionId: null,
          rpcSetVersion: WORKER_RPC_SET_VERSION,
          expiresAtMs: credentialExpiry(),
        },
      },
      assertCurrent,
    );
    stageCredential(
      grantFrom({
        credential: material.credential,
        record: store.getCredential(record.environmentId),
      }),
    );
    return ready;
  };

  const ensurePendingCredential = async (
    record: WorkerEnvironmentRecord,
    sessionId: string | null,
  ) => {
    await store.ready();
    const credential = store.getCredential(record.environmentId);
    const pending = pendingCredentials.get(record.environmentId);
    const turnClaim =
      sessionId === null
        ? undefined
        : options.placementStore?.readWorkerTurnClaim({
            sessionId,
            environmentId: record.environmentId,
            ownerEpoch: record.ownerEpoch,
          });
    const credentialHasDurableTurn =
      credential?.deliveredAtMs !== null &&
      credential?.ownerEpoch === record.ownerEpoch &&
      credential.sessionId === sessionId &&
      sessionId !== null &&
      turnClaim !== undefined &&
      options.placementStore?.validateWorkerTurn(turnClaim) === true;
    const credentialIsCurrent =
      credential?.ownerEpoch === record.ownerEpoch &&
      credential.sessionId === sessionId &&
      (credential.expiresAtMs > now() || credentialHasDurableTurn);
    const pendingIsCurrent =
      credentialIsCurrent &&
      pending?.deliveryId === credential.credentialHash &&
      pending.ownerEpoch === record.ownerEpoch &&
      pending.sessionId === sessionId;
    if (credentialIsCurrent && credential.deliveredAtMs !== null) {
      pendingCredentials.delete(record.environmentId);
      return;
    }
    if (pendingIsCurrent) {
      return;
    }
    pendingCredentials.delete(record.environmentId);
    const minted = await mintCredentialLocked({
      environmentId: record.environmentId,
      ownerEpoch: record.ownerEpoch,
      sessionId,
    });
    stageCredential(minted.grant);
    if (sessionId && credential?.ownerEpoch === record.ownerEpoch) {
      options.liveEvents?.rotateCredential({
        credentialHash: minted.credentialHash,
        environmentId: record.environmentId,
        previousCredentialHash: credential.credentialHash,
        runEpoch: record.ownerEpoch,
        sessionId,
      });
    }
  };

  const attachSession = async (
    request: WorkerCredentialBinding & {
      sessionId: string;
      placementBinding?: PreparedEnvironmentPlacementBinding;
    },
  ): Promise<MintedWorkerCredential> => {
    let stopping = options.isStopping();
    if (stopping) {
      throw serviceError("invalid_state", "Worker environment service is stopping");
    }
    return withLock(request.environmentId, async () => {
      await store.ready();
      stopping = options.isStopping();
      if (stopping) {
        throw serviceError("invalid_state", "Worker environment service is stopping");
      }
      const current = store.get(request.environmentId);
      if (!current) {
        throw serviceError(
          "environment_not_found",
          `Unknown worker environment: ${request.environmentId}`,
        );
      }
      if (current.state !== "ready" && current.state !== "idle") {
        throw serviceError("invalid_state", `Cannot attach worker in state: ${current.state}`);
      }
      let currentBuild: ExpectedWorkerBuild;
      try {
        currentBuild = await options.prepareInstallation("bundle");
      } catch {
        throw serviceError("invalid_state", "Current worker build identity is unavailable");
      }
      if (!current.bootstrapReceipt || !sameWorkerBuild(current.bootstrapReceipt, currentBuild)) {
        throw new StaleWorkerBuildError();
      }
      const material = credentialMaterial();
      try {
        await store.transition({
          environmentId: request.environmentId,
          from: current.state,
          to: "attached",
          expectedOwnerEpoch: request.ownerEpoch,
          placementBinding: request.placementBinding,
          patch: {
            attachedSessionIds: [request.sessionId],
            credential: {
              credentialHash: material.credentialHash,
              sessionId: request.sessionId,
              rpcSetVersion: WORKER_RPC_SET_VERSION,
              expiresAtMs: credentialExpiry(),
            },
          },
        });
      } catch (error) {
        if (error instanceof WorkerSessionAlreadyAttachedError) {
          throw serviceError("invalid_state", error.message);
        }
        throw error;
      }
      pendingCredentials.delete(request.environmentId);
      await tunnels?.stop(request.environmentId, current.ownerEpoch);
      return stageCredential(
        grantFrom({
          credential: material.credential,
          record: store.getCredential(request.environmentId),
        }),
      );
    });
  };

  const readPendingCredential = (
    binding: WorkerCredentialBinding,
    claim?: WorkerSessionTurnClaim,
  ) => {
    const stopping = options.isStopping();
    if (stopping) {
      return undefined;
    }
    const grant = pendingCredentials.get(binding.environmentId);
    if (
      !grant ||
      grant.ownerEpoch !== binding.ownerEpoch ||
      grant.sessionId !== binding.sessionId
    ) {
      return undefined;
    }
    const environment = store.get(binding.environmentId);
    const credential = store.getCredential(binding.environmentId);
    const credentialHash = grant.deliveryId;
    const checkedAtMs = now();
    if (
      !environment ||
      !inState(environment, "ready", "idle", "attached") ||
      environment.destroyRequestedAtMs !== null ||
      environment.ownerEpoch !== binding.ownerEpoch ||
      !credential ||
      credential.credentialHash !== credentialHash ||
      credential.ownerEpoch !== binding.ownerEpoch ||
      credential.sessionId !== binding.sessionId ||
      credential.deliveredAtMs !== null ||
      credential.expiresAtMs <= checkedAtMs ||
      (grant.turnClaim === undefined) !== (claim === undefined) ||
      (claim !== undefined && hashWorkerCredential(grant.credential, claim) !== credentialHash)
    ) {
      return undefined;
    }
    return { checkedAtMs, credentialHash, grant };
  };

  const bindingForClaim = (claim: WorkerSessionTurnClaim) => {
    if (claim.owner.kind !== "worker") {
      throw serviceError("invalid_state", "Worker turn credential claim is not worker-owned");
    }
    return {
      environmentId: claim.owner.environmentId,
      ownerEpoch: claim.owner.ownerEpoch,
      sessionId: claim.sessionId,
    };
  };

  const validateTurnClaim = (claim: WorkerSessionTurnClaim): boolean =>
    claim.owner.kind === "worker" && options.placementStore?.validateWorkerTurn(claim) === true;

  const acquireTurnCredential = (claim: WorkerSessionTurnClaim) => {
    const binding = bindingForClaim(claim);
    return withLock(binding.environmentId, async () => {
      await store.ready();
      const placementStore = options.placementStore;
      if (!placementStore || !validateTurnClaim(claim)) {
        throw serviceError("invalid_state", "Worker turn credential claim is not authoritative");
      }
      const pending = readPendingCredential(binding, claim)?.grant;
      if (pending) {
        return pending;
      }
      const environment = store.get(binding.environmentId);
      if (
        !environment ||
        environment.state !== "attached" ||
        environment.ownerEpoch !== binding.ownerEpoch ||
        environment.attachedSessionIds.length !== 1 ||
        environment.attachedSessionIds[0] !== binding.sessionId
      ) {
        throw serviceError("invalid_state", "Worker session credential owner is not attached");
      }
      const previous = store.getCredential(binding.environmentId);
      const ackedSeq =
        previous?.sessionId === binding.sessionId
          ? placementStore.readWorkerTurnLiveAckCursor(claim)
          : undefined;
      const minted = await mintCredentialLocked(binding, claim);
      const grant = stageCredential(minted.grant);
      if (previous && ackedSeq !== undefined) {
        options.liveEvents?.rotateCredential({
          ackedSeq,
          credentialHash: minted.credentialHash,
          environmentId: binding.environmentId,
          newProcessTurn: true,
          previousCredentialHash: previous.credentialHash,
          runEpoch: binding.ownerEpoch,
          sessionId: binding.sessionId,
        });
      }
      return grant;
    });
  };

  const acknowledgeCredentialDelivery = async (grant: MintedWorkerCredential): Promise<boolean> => {
    await store.ready();
    if (grant.turnClaim && !validateTurnClaim(grant.turnClaim)) {
      return false;
    }
    const pending = readPendingCredential(grant, grant.turnClaim);
    if (!pending || pending.grant.deliveryId !== grant.deliveryId) {
      return false;
    }
    await store.markCredentialDelivered({
      environmentId: grant.environmentId,
      ownerEpoch: grant.ownerEpoch,
      sessionId: grant.sessionId,
      credentialHash: pending.credentialHash,
      deliveredAtMs: pending.checkedAtMs,
      ...(grant.turnClaim
        ? {
            assertCurrent: () => {
              if (!validateTurnClaim(grant.turnClaim!)) {
                throw serviceError(
                  "invalid_state",
                  "Worker turn credential claim is not authoritative",
                );
              }
            },
          }
        : {}),
    });
    if (pendingCredentials.get(grant.environmentId)?.deliveryId === grant.deliveryId) {
      pendingCredentials.delete(grant.environmentId);
    }
    return !grant.turnClaim || validateTurnClaim(grant.turnClaim);
  };

  return {
    acknowledgeCredentialDelivery,
    acquireTurnCredential,
    attachSession,
    clear: () => pendingCredentials.clear(),
    clearEnvironment: (environmentId: string) => pendingCredentials.delete(environmentId),
    commitReady,
    ensurePendingCredential,
    takeMintedCredential: (binding: WorkerCredentialBinding) =>
      readPendingCredential(binding)?.grant,
  };
}

export type WorkerCredentialBroker = ReturnType<typeof createWorkerCredentialBroker>;
