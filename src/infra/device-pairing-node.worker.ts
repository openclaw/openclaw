import type { NodeHostStats } from "../shared/node-host-stats.js";
import { resolveMissingRequestedScope } from "../shared/operator-scope-compat.js";
import type { OpenClawStateDatabase } from "../state/openclaw-state-db.js";
import type { WorkerOperationHandlers } from "../state/worker-operation-registry.js";
import type { NodePairingPendingSnapshot } from "./device-pairing-admission.types.js";
import { devicePairingMutation } from "./device-pairing-dispatch.worker.js";
import {
  type NodePairingGeneration,
  clearNodePairingGenerationState,
  resolveNodePairingGeneration,
  resolveNodePairingState,
} from "./device-pairing-identity.js";
import { requestDevicePairingMutationAdmission } from "./device-pairing-mutation.worker.js";
import {
  buildPendingNodeSurface,
  refreshPendingNodeSurface,
  samePendingApprovalSurface,
  toPairedNode,
  toPendingSnapshot,
  toPublicPendingRequest,
  type RequestNodePairingResult,
  type ApproveNodePairingResult,
  type RecordPairedNodeConnectionResult,
  type NodePairingRequestInput,
} from "./device-pairing-node.records.js";
import {
  persistDevicePairingStoreState,
  readDevicePairingStoreStateFromDatabase,
  updatePairedDeviceInTransaction,
} from "./device-pairing-store.js";
import type { PairedDevice } from "./device-pairing.types.js";
import { resolveNodePairApprovalScopes } from "./node-pairing-authz.js";

function mutatePairedDevices<T>(
  database: OpenClawStateDatabase,
  operate: (paired: Record<string, PairedDevice>) => { value: T; persist: boolean },
): T {
  const state = readDevicePairingStoreStateFromDatabase(database.db);
  const result = operate(state.pairedByDeviceId);
  if (result.persist) {
    persistDevicePairingStoreState(state, undefined, "paired");
  }
  return result.value;
}

type GenerationInput = { nodeId: string; expectedPairingGeneration: NodePairingGeneration };
type NodeSurface = NonNullable<PairedDevice["nodeSurface"]>;

function updateNodeSurface(
  input: GenerationInput,
  update: (surface: NodeSurface) => NodeSurface,
  matches: (surface: NodeSurface) => boolean = () => true,
): boolean {
  const { nodeId, expectedPairingGeneration } = input;
  return updatePairedDeviceInTransaction(nodeId, undefined, (device) => {
    const surface = device?.nodeSurface;
    if (
      !device ||
      !surface ||
      expectedPairingGeneration.nodeId !== device.deviceId ||
      resolveNodePairingGeneration(device)?.key !== expectedPairingGeneration.key ||
      !matches(surface)
    ) {
      return { value: false };
    }
    requestDevicePairingMutationAdmission({
      kind: "node-surface",
      nodeId: device.deviceId,
      pairingGeneration: expectedPairingGeneration.key,
    });
    return { value: true, patch: { nodeSurface: update(surface) } };
  });
}

export const nodePairingOperations = {
  "node.request": devicePairingMutation(
    (input: { req: NodePairingRequestInput; nowMs: number }, { database }) => {
      const { req, nowMs } = input;
      const nodeId = req.nodeId.trim();
      if (!nodeId) {
        throw new Error("nodeId required");
      }
      return mutatePairedDevices<RequestNodePairingResult>(database, (paired) => {
        const device = paired[nodeId];
        if (!device) {
          throw new Error("node pairing requires a paired device");
        }
        requestDevicePairingMutationAdmission({ kind: "node-surface", nodeId });
        const existing = device.pendingNodeSurface;
        if (existing && samePendingApprovalSurface(existing, { ...req, nodeId })) {
          const refreshed = refreshPendingNodeSurface(existing, req, nowMs);
          device.pendingNodeSurface = refreshed;
          return {
            value: {
              status: "pending",
              request: toPublicPendingRequest(device, refreshed),
              created: false,
            },
            persist: true,
          };
        }
        const replacement = buildPendingNodeSurface({ req: { ...req, nodeId }, nowMs });
        device.pendingNodeSurface = replacement;
        const superseded = existing ? [{ requestId: existing.requestId, nodeId }] : [];
        return {
          value: {
            status: "pending",
            request: toPublicPendingRequest(device, replacement),
            created: true,
            ...(superseded.length > 0 ? { superseded } : {}),
          },
          persist: true,
        };
      });
    },
  ),
  "node.finalizeCleanup": devicePairingMutation(
    (input: { observed: NodePairingPendingSnapshot }, { database }) => {
      const { observed } = input;
      return mutatePairedDevices(database, (paired) => {
        const device = paired[observed.nodeId.trim()];
        const pending = device?.pendingNodeSurface;
        if (
          !device ||
          !pending ||
          observed.requestId !== pending.requestId ||
          observed.revision !== pending.revision
        ) {
          return { value: [], persist: false };
        }
        requestDevicePairingMutationAdmission({
          kind: "node-pending",
          ...toPendingSnapshot(device, pending),
        });
        delete device.pendingNodeSurface;
        return {
          value: [{ requestId: pending.requestId, nodeId: device.deviceId }],
          persist: true,
        };
      });
    },
  ),
  "node.approve": devicePairingMutation(
    (
      input: { requestId: string; callerScopes?: readonly string[]; nowMs: number },
      { database },
    ) => {
      const { requestId, callerScopes, nowMs } = input;
      return mutatePairedDevices<ApproveNodePairingResult>(database, (paired) => {
        const device = Object.values(paired).find(
          (entry) => entry.pendingNodeSurface?.requestId === requestId,
        );
        const pending = device?.pendingNodeSurface;
        if (!device || !pending) {
          return { value: null, persist: false };
        }
        requestDevicePairingMutationAdmission({
          kind: "node-pending",
          ...toPendingSnapshot(device, pending),
        });
        const missingScope = resolveMissingRequestedScope({
          role: "operator",
          requestedScopes: resolveNodePairApprovalScopes(pending.commands ?? []),
          allowedScopes: callerScopes ?? [],
        });
        if (missingScope) {
          return { value: { status: "forbidden", missingScope }, persist: false };
        }
        const previousPairingGeneration = resolveNodePairingGeneration(device);
        const now = Math.max(nowMs, (device.nodeSurface?.approvedAtMs ?? -1) + 1);
        device.nodeSurface = {
          displayName: device.nodeSurface?.displayName ?? pending.displayName,
          version: pending.version,
          coreVersion: pending.coreVersion,
          uiVersion: pending.uiVersion,
          modelIdentifier: pending.modelIdentifier,
          caps: pending.caps,
          commands: pending.commands,
          permissions: pending.permissions,
          bins: device.nodeSurface?.bins,
          createdAtMs: device.nodeSurface?.createdAtMs ?? now,
          approvedAtMs: now,
          lastConnectedAtMs: device.nodeSurface?.lastConnectedAtMs,
          lastHostStats: device.nodeSurface?.lastHostStats,
        };
        delete device.pendingNodeSurface;
        const nextPairingState = resolveNodePairingState(device);
        const nextPairingGeneration = nextPairingState?.generation?.key;
        if (!nextPairingState || !nextPairingGeneration) {
          return { value: null, persist: false };
        }
        clearNodePairingGenerationState(device, previousPairingGeneration);
        const node = toPairedNode(device);
        return node
          ? {
              value: {
                requestId,
                node,
                pairingIdentity: nextPairingState.identity.key,
                nextPairingGeneration,
                ...(previousPairingGeneration
                  ? { previousPairingGeneration: previousPairingGeneration.key }
                  : {}),
              },
              persist: true,
            }
          : { value: null, persist: false };
      });
    },
  ),
  "node.reject": devicePairingMutation((input: { requestId: string }, { database }) => {
    const { requestId } = input;
    return mutatePairedDevices(database, (paired) => {
      const device = Object.values(paired).find(
        (entry) => entry.pendingNodeSurface?.requestId === requestId,
      );
      const pending = device?.pendingNodeSurface;
      if (!device || !pending) {
        return { value: null, persist: false };
      }
      requestDevicePairingMutationAdmission({
        kind: "node-pending",
        ...toPendingSnapshot(device, pending),
      });
      delete device.pendingNodeSurface;
      return { value: { requestId, nodeId: device.deviceId }, persist: true };
    });
  }),
  "node.rename": devicePairingMutation(
    (input: { nodeId: string; displayName: string }, { database }) => {
      const displayName = input.displayName.trim();
      if (!displayName) {
        throw new Error("displayName required");
      }
      return mutatePairedDevices(database, (paired) => {
        const device = paired[input.nodeId.trim()];
        if (!device?.nodeSurface) {
          return { value: null, persist: false };
        }
        requestDevicePairingMutationAdmission({
          kind: "node-surface",
          nodeId: device.deviceId,
          pairingGeneration: resolveNodePairingGeneration(device)?.key,
        });
        device.nodeSurface = { ...device.nodeSurface, displayName };
        return { value: toPairedNode(device), persist: true };
      });
    },
  ),
  "node.recordConnection": devicePairingMutation(
    (input: {
      nodeId: string;
      connectedAtMs: number;
      expectedPairingGeneration?: NodePairingGeneration;
    }) => {
      const { nodeId, connectedAtMs, expectedPairingGeneration } = input;
      return updatePairedDeviceInTransaction<RecordPairedNodeConnectionResult>(
        nodeId,
        undefined,
        (device) => {
          if (
            !device?.nodeSurface ||
            (expectedPairingGeneration &&
              (expectedPairingGeneration.nodeId !== device.deviceId ||
                resolveNodePairingGeneration(device)?.key !== expectedPairingGeneration.key))
          ) {
            return { value: { recorded: false } };
          }
          requestDevicePairingMutationAdmission({
            kind: "node-surface",
            nodeId: device.deviceId,
            pairingGeneration: resolveNodePairingGeneration(device)?.key,
          });
          const firstConnection = device.nodeSurface.lastConnectedAtMs === undefined;
          const lastConnectedAtMs = Math.max(
            device.nodeSurface.lastConnectedAtMs ?? connectedAtMs,
            connectedAtMs,
          );
          const clearsDisconnect =
            device.nodeSurface.lastDisconnectedAtMs !== undefined &&
            connectedAtMs > device.nodeSurface.lastDisconnectedAtMs;
          return {
            value: { recorded: true, firstConnection },
            patch: {
              nodeSurface: {
                ...device.nodeSurface,
                lastConnectedAtMs,
                ...(clearsDisconnect ? { lastDisconnectedAtMs: undefined } : {}),
              },
            },
          };
        },
      );
    },
  ),
  "node.recordDisconnection": devicePairingMutation(
    (input: GenerationInput & { connectedAtMs: number; disconnectedAtMs: number }) =>
      updateNodeSurface(
        input,
        (surface) => ({
          ...surface,
          lastDisconnectedAtMs: Math.max(
            surface.lastDisconnectedAtMs ?? input.disconnectedAtMs,
            input.disconnectedAtMs,
          ),
        }),
        (surface) =>
          surface.lastConnectedAtMs === input.connectedAtMs &&
          !(input.disconnectedAtMs < input.connectedAtMs),
      ),
  ),
  "node.recordHostStats": devicePairingMutation(
    (input: GenerationInput & { hostStats: NodeHostStats }) =>
      updateNodeSurface(input, (surface) => ({ ...surface, lastHostStats: input.hostStats })),
  ),
  "node.updateBins": devicePairingMutation((input: GenerationInput & { bins: string[] }) =>
    updateNodeSurface(input, (surface) => ({ ...surface, bins: input.bins })),
  ),
  "node.updateSessionHost": devicePairingMutation(
    (input: GenerationInput & { sessionHost: boolean }) =>
      updateNodeSurface(input, (surface) => ({ ...surface, sessionHost: input.sessionHost })),
  ),
} satisfies WorkerOperationHandlers;
