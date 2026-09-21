import { resolveMissingRequestedScope } from "../shared/operator-scope-compat.js";
import type { OpenClawStateDatabase } from "../state/openclaw-state-db.js";
import {
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
} from "./device-pairing-node.records.js";
import type {
  DevicePairingNodeMutation,
  DevicePairingNodeWorkerOperations,
} from "./device-pairing-node.worker-contract.js";
import {
  persistDevicePairingStoreState,
  readDevicePairingStoreStateFromDatabase,
  updatePairedDeviceNodeSurfaceInTransaction,
} from "./device-pairing-store.js";
import type { PairedDevice } from "./device-pairing.types.js";
import { resolveNodePairApprovalScopes } from "./node-pairing-authz.js";

type NodeMutationResult =
  DevicePairingNodeWorkerOperations[keyof DevicePairingNodeWorkerOperations]["output"];

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

/** Root pairing admission holds the exact database transaction through all row decisions. */
export function executeDevicePairingNodeMutation(
  command: DevicePairingNodeMutation,
  database: OpenClawStateDatabase,
): NodeMutationResult {
  switch (command.type) {
    case "node.request": {
      const { req, nowMs } = command.input;
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
    }
    case "node.finalizeCleanup": {
      const { observed } = command.input;
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
    }
    case "node.approve": {
      const { requestId, callerScopes, nowMs } = command.input;
      return mutatePairedDevices<DevicePairingNodeWorkerOperations["node.approve"]["output"]>(
        database,
        (paired) => {
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
        },
      );
    }
    case "node.reject": {
      const { requestId } = command.input;
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
    }
    case "node.rename": {
      const displayName = command.input.displayName.trim();
      if (!displayName) {
        throw new Error("displayName required");
      }
      return mutatePairedDevices(database, (paired) => {
        const device = paired[command.input.nodeId.trim()];
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
    }
    case "node.recordConnection": {
      const { nodeId, connectedAtMs, expectedPairingGeneration } = command.input;
      return updatePairedDeviceNodeSurfaceInTransaction<
        DevicePairingNodeWorkerOperations["node.recordConnection"]["output"]
      >(nodeId, undefined, (device) => {
        if (
          !device?.nodeSurface ||
          (expectedPairingGeneration &&
            (expectedPairingGeneration.nodeId !== device.deviceId ||
              resolveNodePairingGeneration(device)?.key !== expectedPairingGeneration.key))
        ) {
          return { value: { recorded: false }, persist: false };
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
          persist: true,
          nodeSurface: {
            ...device.nodeSurface,
            lastConnectedAtMs,
            ...(clearsDisconnect ? { lastDisconnectedAtMs: undefined } : {}),
          },
        };
      });
    }
    default: {
      const { nodeId, expectedPairingGeneration } = command.input;
      return updatePairedDeviceNodeSurfaceInTransaction<boolean>(nodeId, undefined, (device) => {
        const surface = device?.nodeSurface;
        if (
          !device ||
          !surface ||
          expectedPairingGeneration.nodeId !== device.deviceId ||
          resolveNodePairingGeneration(device)?.key !== expectedPairingGeneration.key
        ) {
          return { value: false, persist: false };
        }
        if (
          command.type === "node.recordDisconnection" &&
          (surface.lastConnectedAtMs !== command.input.connectedAtMs ||
            command.input.disconnectedAtMs < command.input.connectedAtMs)
        ) {
          return { value: false, persist: false };
        }
        requestDevicePairingMutationAdmission({
          kind: "node-surface",
          nodeId: device.deviceId,
          pairingGeneration: expectedPairingGeneration.key,
        });
        switch (command.type) {
          case "node.recordDisconnection":
            return {
              value: true,
              persist: true,
              nodeSurface: {
                ...surface,
                lastDisconnectedAtMs: Math.max(
                  surface.lastDisconnectedAtMs ?? command.input.disconnectedAtMs,
                  command.input.disconnectedAtMs,
                ),
              },
            };
          case "node.recordHostStats":
            return {
              value: true,
              persist: true,
              nodeSurface: { ...surface, lastHostStats: command.input.hostStats },
            };
          case "node.updateBins":
            return {
              value: true,
              persist: true,
              nodeSurface: { ...surface, bins: command.input.bins },
            };
          case "node.updateSessionHost":
            return {
              value: true,
              persist: true,
              nodeSurface: { ...surface, sessionHost: command.input.sessionHost },
            };
        }
        throw new Error("Unsupported paired node surface mutation");
      });
    }
  }
}
