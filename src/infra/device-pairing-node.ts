// Node surface policy runs in the pairing worker; reconnect claims belong to the live Gateway.
import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { NodeHostStats } from "../shared/node-host-stats.js";
import type { NodePairingGeneration } from "./device-pairing-identity.js";
import {
  projectNodePairing,
  samePendingApprovalSurface,
  samePendingReconnectMetadata,
  toPairedNode,
  toPendingSnapshot,
  toPublicPendingRequest,
  type ApproveNodePairingResult,
  type NodePairingCleanupClaim,
  type NodePairingList,
  type NodePairingListWithGeneration,
  type NodePairingPendingSnapshot,
  type NodePairingRequestInput,
  type NodePairingSupersededRequest,
  type PairedDeviceNode,
  type RecordPairedNodeConnectionResult,
  type RequestNodePairingResult,
} from "./device-pairing-node.records.js";
import {
  DevicePairingAuthorityRefusedError,
  executeDevicePairingMutation,
  withCurrentDevicePairingSnapshot,
} from "./device-pairing-worker.js";
import type { PairedDevice, PairedDevicePendingNodeSurface } from "./device-pairing.types.js";

export { projectNodePairing } from "./device-pairing-node.records.js";
export type {
  NodePairingCleanupClaim,
  NodePairingPendingRequest,
  NodePairingRequestInput,
  NodePairingSupersededRequest,
  PairedDeviceNode,
  RequestNodePairingResult,
} from "./device-pairing-node.records.js";

const activeCleanupRevisionClaims = new Map<string, Set<number>>();
let nextCleanupClaimGeneration = 0;

function buildCleanupRevisionClaimKey(
  baseDir: string | undefined,
  observed: NodePairingPendingSnapshot,
): string {
  return `${baseDir ?? ""}\0${observed.nodeId}\0${observed.requestId}\0${observed.revision ?? ""}`;
}

function addCleanupClaim(claim: NodePairingCleanupClaim): void {
  const key = buildCleanupRevisionClaimKey(claim.baseDir, claim.observed);
  const generations = activeCleanupRevisionClaims.get(key) ?? new Set<number>();
  generations.add(claim.generation);
  activeCleanupRevisionClaims.set(key, generations);
}

function cleanupClaimIsActive(claim: NodePairingCleanupClaim): boolean {
  const key = buildCleanupRevisionClaimKey(claim.baseDir, claim.observed);
  return activeCleanupRevisionClaims.get(key)?.has(claim.generation) === true;
}

function removeCleanupClaim(claim: NodePairingCleanupClaim): void {
  const key = buildCleanupRevisionClaimKey(claim.baseDir, claim.observed);
  const generations = activeCleanupRevisionClaims.get(key);
  generations?.delete(claim.generation);
  if (!generations || generations.size === 0) {
    activeCleanupRevisionClaims.delete(key);
  }
}

function invalidateCleanupClaimsThrough(
  claim: NodePairingCleanupClaim,
  device: PairedDevice,
  pending: PairedDevicePendingNodeSurface,
): void {
  const key = buildCleanupRevisionClaimKey(claim.baseDir, toPendingSnapshot(device, pending));
  const generations = activeCleanupRevisionClaims.get(key);
  if (!generations) {
    return;
  }
  for (const generation of generations) {
    if (generation <= claim.generation) {
      generations.delete(generation);
    }
  }
  if (generations.size === 0) {
    activeCleanupRevisionClaims.delete(key);
  }
}

export function listNodePairing(baseDir?: string): Promise<NodePairingList>;
export function listNodePairing(
  baseDir: string | undefined,
  options: { includePairingGeneration: true },
): Promise<NodePairingListWithGeneration>;
export async function listNodePairing(
  baseDir?: string,
  options?: { includePairingGeneration?: boolean },
): Promise<NodePairingList | NodePairingListWithGeneration> {
  return expectDefined(
    await withCurrentDevicePairingSnapshot(baseDir, (paired) => ({
      start: () => projectNodePairing(paired, options),
    })),
    "node pairing snapshot",
  );
}

/** Claim pending revisions in the same owner interval that acquires their current snapshot. */
export async function beginNodePairingConnect(
  nodeId: string,
  baseDir?: string,
): Promise<{ pairedNode: PairedDeviceNode | null; cleanupClaim?: NodePairingCleanupClaim }> {
  return expectDefined(
    await withCurrentDevicePairingSnapshot(baseDir, (paired) => ({
      start: () => {
        const device = paired.find((entry) => entry.deviceId === nodeId.trim());
        const pairedNode = device ? toPairedNode(device) : null;
        const pending = device?.pendingNodeSurface;
        if (!device || !pairedNode || !pending) {
          return { pairedNode };
        }
        const claim: NodePairingCleanupClaim = {
          baseDir,
          generation: ++nextCleanupClaimGeneration,
          nodeId: device.deviceId,
          observed: toPendingSnapshot(device, pending),
        };
        addCleanupClaim(claim);
        return { pairedNode, cleanupClaim: claim };
      },
    })),
    "node reconnect snapshot",
  );
}

export async function releaseNodePairingCleanupClaim(
  claim: NodePairingCleanupClaim,
): Promise<void> {
  removeCleanupClaim(claim);
}

export async function finalizeNodePairingCleanupClaim(
  claim: NodePairingCleanupClaim,
): Promise<NodePairingSupersededRequest[]> {
  if (!cleanupClaimIsActive(claim)) {
    return [];
  }
  try {
    return await executeDevicePairingMutation(
      {
        type: "node.finalizeCleanup",
        input: { observed: claim.observed },
      },
      {
        baseDir: claim.baseDir,
        assertCurrent: () => {
          if (!cleanupClaimIsActive(claim)) {
            throw new DevicePairingAuthorityRefusedError("node reconnect cleanup claim changed");
          }
        },
      },
    );
  } catch (error) {
    if (error instanceof DevicePairingAuthorityRefusedError) {
      return [];
    }
    throw error;
  } finally {
    removeCleanupClaim(claim);
  }
}

export function requestNodePairing(
  req: NodePairingRequestInput,
  baseDir?: string,
): Promise<RequestNodePairingResult> {
  return executeDevicePairingMutation(
    { type: "node.request", input: { req, nowMs: Date.now() } },
    { baseDir },
  );
}

/** An unchanged reconnect supersedes earlier cleanup ownership without writing the row. */
export async function reusePendingNodePairingForReconnect(
  req: NodePairingRequestInput,
  cleanupClaim: NodePairingCleanupClaim | undefined,
  baseDir?: string,
): Promise<RequestNodePairingResult | null> {
  const result = await withCurrentDevicePairingSnapshot(baseDir, (paired) => ({
    start: () => {
      const nodeId = req.nodeId.trim();
      const device = paired.find((entry) => entry.deviceId === nodeId);
      const pending = device?.pendingNodeSurface;
      if (
        !device ||
        !pending ||
        !samePendingApprovalSurface(pending, { ...req, nodeId }) ||
        !samePendingReconnectMetadata(pending, req)
      ) {
        return null;
      }
      if (cleanupClaim) {
        invalidateCleanupClaimsThrough(cleanupClaim, device, pending);
      }
      return {
        status: "pending" as const,
        request: toPublicPendingRequest(device, pending),
        created: false,
      };
    },
  }));
  return result ?? null;
}

export async function approveNodePairing(
  requestId: string,
  options: { callerScopes?: readonly string[] },
  baseDir?: string,
): Promise<ApproveNodePairingResult> {
  try {
    return await executeDevicePairingMutation(
      {
        type: "node.approve",
        input: { requestId, callerScopes: options.callerScopes, nowMs: Date.now() },
      },
      {
        baseDir,
        admit: (facts) => {
          if (
            !isRecord(facts) ||
            facts.kind !== "node-pending" ||
            typeof facts.nodeId !== "string" ||
            typeof facts.requestId !== "string" ||
            (facts.revision !== undefined && typeof facts.revision !== "string")
          ) {
            throw new Error("invalid node pending admission facts");
          }
          const key = buildCleanupRevisionClaimKey(baseDir, {
            nodeId: facts.nodeId,
            requestId: facts.requestId,
            revision: facts.revision,
          });
          if ((activeCleanupRevisionClaims.get(key)?.size ?? 0) > 0) {
            throw new DevicePairingAuthorityRefusedError("node reconnect owns pending revision");
          }
        },
      },
    );
  } catch (error) {
    if (error instanceof DevicePairingAuthorityRefusedError) {
      return null;
    }
    throw error;
  }
}

export function rejectNodePairing(
  requestId: string,
  baseDir?: string,
): Promise<{ requestId: string; nodeId: string } | null> {
  return executeDevicePairingMutation({ type: "node.reject", input: { requestId } }, { baseDir });
}

export async function getPendingNodePairing(
  requestId: string,
  baseDir?: string,
): Promise<{ requestId: string; nodeId: string } | null> {
  const result = await withCurrentDevicePairingSnapshot(baseDir, (paired) => ({
    start: () => {
      const device = paired.find((entry) => entry.pendingNodeSurface?.requestId === requestId);
      return device ? { requestId, nodeId: device.deviceId } : null;
    },
  }));
  return result ?? null;
}

export function recordPairedNodeConnection(
  nodeId: string,
  connectedAtMs: number,
  baseDir?: string,
  expectedPairingGeneration?: NodePairingGeneration,
): Promise<RecordPairedNodeConnectionResult> {
  return executeDevicePairingMutation(
    { type: "node.recordConnection", input: { nodeId, connectedAtMs, expectedPairingGeneration } },
    { baseDir },
  );
}

export function recordPairedNodeHostStats(params: {
  nodeId: string;
  hostStats: NodeHostStats;
  expectedPairingGeneration: NodePairingGeneration;
  baseDir?: string;
}): Promise<boolean> {
  const { baseDir, ...input } = params;
  return executeDevicePairingMutation({ type: "node.recordHostStats", input }, { baseDir });
}

export async function recordPairedNodeDisconnection(params: {
  nodeId: string;
  connectedAtMs: number;
  disconnectedAtMs: number;
  expectedPairingGeneration: NodePairingGeneration;
  baseDir?: string;
}): Promise<{ recorded: boolean }> {
  const { baseDir, ...input } = params;
  return {
    recorded: await executeDevicePairingMutation(
      { type: "node.recordDisconnection", input },
      { baseDir },
    ),
  };
}

export function renamePairedNode(
  nodeId: string,
  displayName: string,
  baseDir?: string,
): Promise<PairedDeviceNode | null> {
  return executeDevicePairingMutation(
    { type: "node.rename", input: { nodeId, displayName } },
    { baseDir },
  );
}
