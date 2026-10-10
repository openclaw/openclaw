import {
  ErrorCodes,
  errorShape,
  missingScopeErrorShape,
  validateNodePairApproveParams,
  validateNodePairListParams,
  validateNodePairRejectParams,
  validateNodePairRemoveParams,
  validateNodeRenameParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { captureNodePairingState } from "../../infra/device-pairing-node-state.js";
import {
  approveNodePairing,
  getPendingNodePairing,
  listNodePairing,
  rejectNodePairing,
  renamePairedNode,
} from "../../infra/device-pairing-node.js";
import {
  getPairedDevice,
  listApprovedPairedDeviceRoles,
  removePairedDeviceRole,
} from "../../infra/device-pairing.js";
import { reconcileRevokedDeviceWorker } from "../device-worker-revocation.js";
import { clearRemovedNodeRuntimeState } from "../node-runtime-state.js";
import { invalidateNodeWakeState } from "../node-wake-state.js";
import { PAIRING_SCOPE } from "../operator-scopes.js";
import {
  deniesCrossDeviceManagement,
  pairedDeviceHasNonOperatorRole,
  resolveDeviceManagementAuthz,
  resolveDeviceSessionAuthz,
  type DeviceManagementAuthz,
} from "./device-management-authz.js";
import { emitDeviceManagementSecurityEvent } from "./device-management-security.js";
import { refreshConnectedNodeSurfaceCaches } from "./nodes.read.js";
import { respondUnavailableOnThrow } from "./response.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./shared-types.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

function emitNodePairingDeniedSecurityEvent(params: {
  authz: DeviceManagementAuthz;
  nodeId: string;
  controlId: "node.pair.approve" | "node.pair.reject" | "node.rename";
  reason: string;
}): void {
  emitDeviceManagementSecurityEvent({
    action: "device.pairing.denied",
    outcome: "denied",
    severity: "medium",
    authz: params.authz,
    targetDeviceId: params.nodeId,
    policyId: "gateway.device-pairing",
    decision: "deny",
    controlId: params.controlId,
    reason: params.reason,
    attributes: { role: "node" },
  });
}

async function enforcePendingNodePairingOwnership(params: {
  requestId: string;
  mutation: "approve" | "reject";
  client: GatewayClient | null;
  context: Pick<GatewayRequestContext, "logGateway">;
  respond: RespondFn;
}): Promise<boolean> {
  const action = params.mutation === "approve" ? "approval" : "rejection";
  const controlId = params.mutation === "approve" ? "node.pair.approve" : "node.pair.reject";
  const deniedMessage = `node pairing ${action} denied`;
  const pending = await getPendingNodePairing(params.requestId);
  const sessionAuthz = resolveDeviceSessionAuthz(params.client);
  if (!pending) {
    if (sessionAuthz.callerDeviceId && !sessionAuthz.isAdminCaller) {
      params.respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, deniedMessage));
      return false;
    }
    return true;
  }

  const authz = resolveDeviceManagementAuthz(params.client, pending.nodeId);
  if (!deniesCrossDeviceManagement(authz)) {
    return true;
  }
  params.context.logGateway.warn(
    `${deniedMessage} node=${pending.nodeId} reason=device-ownership-mismatch`,
  );
  emitNodePairingDeniedSecurityEvent({
    authz,
    nodeId: pending.nodeId,
    controlId,
    reason: "device-ownership-mismatch",
  });
  params.respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, deniedMessage));
  return false;
}

function emitNodeRoleRemovalSecurityEvent(params: {
  authz: DeviceManagementAuthz;
  deviceId: string;
  reason?: string;
  removedDevice?: boolean;
}): void {
  const denied = params.reason !== undefined;
  emitDeviceManagementSecurityEvent({
    action: denied ? "device.role.removal_denied" : "device.role.removed",
    outcome: denied ? "denied" : "success",
    severity: "medium",
    authz: params.authz,
    targetDeviceId: params.deviceId,
    policyId: "gateway.device-pairing",
    decision: denied ? "deny" : "allow",
    controlId: "node.pair.remove",
    ...(params.reason ? { reason: params.reason } : {}),
    attributes: {
      role: "node",
      ...(params.removedDevice !== undefined ? { removed_device: params.removedDevice } : {}),
    },
  });
}

export const nodePairingHandlers: GatewayRequestHandlers = {
  "node.pair.list": async ({ params, respond, client }) => {
    if (!assertValidParams(params, validateNodePairListParams, "node.pair.list", respond)) {
      return;
    }
    await respondUnavailableOnThrow(respond, async () => {
      const list = await listNodePairing();
      const authz = resolveDeviceSessionAuthz(client);
      const visibleList =
        authz.callerDeviceId && !authz.isAdminCaller
          ? {
              pending: list.pending.filter(
                (request) => request.nodeId.trim() === authz.callerDeviceId,
              ),
              paired: list.paired.filter((node) => node.nodeId.trim() === authz.callerDeviceId),
            }
          : list;
      respond(true, visibleList, undefined);
    });
  },
  "node.pair.approve": async ({ params, respond, context, client }) => {
    if (!assertValidParams(params, validateNodePairApproveParams, "node.pair.approve", respond)) {
      return;
    }
    const { requestId } = params;
    // Intentionally fail closed for RPC callers without an explicit scoped session.
    const callerScopes = Array.isArray(client?.connect?.scopes) ? client.connect.scopes : [];
    await respondUnavailableOnThrow(respond, async () => {
      if (
        !(await enforcePendingNodePairingOwnership({
          requestId,
          mutation: "approve",
          client,
          context,
          respond,
        }))
      ) {
        return;
      }
      const pendingApproval = await getPendingNodePairing(requestId);
      const pairingStateBeforeApproval = pendingApproval
        ? await captureNodePairingState(pendingApproval.nodeId)
        : null;
      const sessionBeforeApproval = pendingApproval
        ? context.nodeRegistry.get(pendingApproval.nodeId)
        : undefined;
      const approved = await approveNodePairing(requestId, { callerScopes });
      if (!approved) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown requestId"));
        return;
      }
      if ("status" in approved && approved.status === "forbidden") {
        respond(
          false,
          undefined,
          missingScopeErrorShape({
            missingScope: approved.missingScope,
            requiredScopes:
              approved.missingScope === PAIRING_SCOPE
                ? [PAIRING_SCOPE]
                : [PAIRING_SCOPE, approved.missingScope],
          }),
        );
        return;
      }
      if (!("node" in approved)) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown requestId"));
        return;
      }
      const approvedNode = approved.node;
      // Surface approval rotates the persistent generation. Abort any wake
      // already admitted under the prior command surface before it can send.
      invalidateNodeWakeState(approvedNode.nodeId);
      // Only the exact generation committed by this approval may inherit the
      // authenticated live session. A later re-pair must reconnect instead.
      const persistedApprovedState = await captureNodePairingState(approvedNode.nodeId);
      const previousGenerationKey = pairingStateBeforeApproval?.generation?.key;
      const liveSessionOwnsPreviousPairingState = Boolean(
        sessionBeforeApproval &&
        pairingStateBeforeApproval?.identity.key === approved.pairingIdentity &&
        sessionBeforeApproval.pairingIdentity === approved.pairingIdentity &&
        approved.previousPairingGeneration === previousGenerationKey &&
        sessionBeforeApproval.pairingGeneration === previousGenerationKey,
      );
      const updatedNode =
        liveSessionOwnsPreviousPairingState &&
        sessionBeforeApproval &&
        persistedApprovedState?.identity.key === approved.pairingIdentity &&
        persistedApprovedState.generation?.key === approved.nextPairingGeneration
          ? context.nodeRegistry.updateSurface(
              approvedNode.nodeId,
              {
                caps: approvedNode.caps ?? [],
                commands: approvedNode.commands ?? [],
                permissions: approvedNode.permissions,
              },
              {
                expectedConnId: sessionBeforeApproval.connId,
                expectedPairingIdentity: approved.pairingIdentity,
                ...(previousGenerationKey
                  ? { expectedPairingGeneration: previousGenerationKey }
                  : {}),
                nextPairingGeneration: approved.nextPairingGeneration,
              },
            )
          : null;
      const resolved = {
        requestId,
        nodeId: approvedNode.nodeId,
        decision: "approved",
        ts: Date.now(),
      };
      if (updatedNode) {
        refreshConnectedNodeSurfaceCaches({ context, nodeSession: updatedNode });
        const notified = await context.nodeRegistry.sendEventForPairingIdentity({
          nodeId: updatedNode.nodeId,
          connId: updatedNode.connId,
          pairingIdentity: approved.pairingIdentity,
          event: "node.pair.resolved",
          payload: resolved,
        });
        if (!notified) {
          context.logGateway.warn(
            `node approval refresh was not delivered for ${approvedNode.nodeId}; the current node must republish after reconnect`,
          );
        }
      }
      context.broadcast("node.pair.resolved", resolved, { dropIfSlow: true });
      respond(true, { requestId: approved.requestId, node: approvedNode }, undefined);
    });
  },
  "node.pair.reject": async ({ params, respond, context, client }) => {
    if (!assertValidParams(params, validateNodePairRejectParams, "node.pair.reject", respond)) {
      return;
    }
    const { requestId } = params;
    await respondUnavailableOnThrow(respond, async () => {
      if (
        !(await enforcePendingNodePairingOwnership({
          requestId,
          mutation: "reject",
          client,
          context,
          respond,
        }))
      ) {
        return;
      }
      const rejected = await rejectNodePairing(requestId);
      if (!rejected) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown requestId"));
        return;
      }
      context.broadcast(
        "node.pair.resolved",
        {
          requestId,
          nodeId: rejected.nodeId,
          decision: "rejected",
          ts: Date.now(),
        },
        { dropIfSlow: true },
      );
      respond(true, rejected, undefined);
    });
  },
  // Remove a node pairing (CLI: `openclaw nodes remove`). This revokes the
  // device's `node` role in the paired-device store, which drops the approved node
  // surface with it, and disconnects the device's node-role sessions: a
  // mixed-role device keeps its row and only loses the `node` role, a
  // node-only device row is deleted. Authz mirrors device.pair.remove:
  // operator.pairing may remove non-operator node rows; a device-token caller
  // revoking its own node role on a mixed-role device additionally needs
  // operator.admin.
  "node.pair.remove": async ({ params, respond, context, client }) => {
    if (!assertValidParams(params, validateNodePairRemoveParams, "node.pair.remove", respond)) {
      return;
    }
    const nodeId = params.nodeId.trim();
    await respondUnavailableOnThrow(respond, async () => {
      const paired = nodeId ? await getPairedDevice(nodeId) : null;
      if (!paired || !listApprovedPairedDeviceRoles(paired).includes("node")) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown nodeId"));
        return;
      }
      const authz = resolveDeviceManagementAuthz(client, nodeId);
      // Shared-auth operators manage node roles on others' behalf. Only device-token
      // self-service callers need admin scope to remove a mixed-role pairing.
      const reason = deniesCrossDeviceManagement(authz)
        ? "device-ownership-mismatch"
        : authz.callerDeviceId && !authz.isAdminCaller && pairedDeviceHasNonOperatorRole(paired)
          ? "role-management-requires-admin"
          : undefined;
      if (reason) {
        context.logGateway.warn(`node pairing removal denied node=${nodeId} reason=${reason}`);
        emitNodeRoleRemovalSecurityEvent({ authz, deviceId: nodeId, reason });
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "node pairing removal denied"),
        );
        return;
      }
      const removed = await removePairedDeviceRole({ deviceId: nodeId, role: "node" });
      if (!removed) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown nodeId"));
        return;
      }
      context.logGateway.info(`node pairing removed device-backed node=${removed.deviceId}`);
      emitNodeRoleRemovalSecurityEvent({
        authz,
        deviceId: removed.deviceId,
        removedDevice: removed.removedDevice,
      });
      // Invalidate before responding so pipelined frames using the retired token fail.
      // The hard close below stays after the success response.
      context.invalidateClientsForDevice?.(removed.deviceId, {
        role: "node",
        reason: "device-pair-removed",
      });
      try {
        clearRemovedNodeRuntimeState({ nodeId: removed.deviceId, context });
        await reconcileRevokedDeviceWorker(context, removed.deviceId);
        context.broadcast(
          "node.pair.resolved",
          {
            requestId: "",
            nodeId: removed.deviceId,
            decision: "removed",
            ts: Date.now(),
          },
          { dropIfSlow: true },
        );
        respond(true, { nodeId: removed.deviceId }, undefined);
      } finally {
        // Preserve response-first shutdown on success, while guaranteeing the
        // hard close when runtime cleanup or later bookkeeping throws.
        queueMicrotask(() => {
          context.disconnectClientsForDevice?.(removed.deviceId, {
            role: "node",
          });
        });
      }
    });
  },
  "node.rename": async ({ params, respond, context, client }) => {
    if (!assertValidParams(params, validateNodeRenameParams, "node.rename", respond)) {
      return;
    }
    const { nodeId, displayName } = params;
    await respondUnavailableOnThrow(respond, async () => {
      const authz = resolveDeviceManagementAuthz(client, nodeId);
      if (deniesCrossDeviceManagement(authz)) {
        context.logGateway.warn(
          `node rename denied node=${authz.normalizedTargetDeviceId} reason=device-ownership-mismatch`,
        );
        emitNodePairingDeniedSecurityEvent({
          authz,
          nodeId: authz.normalizedTargetDeviceId,
          controlId: "node.rename",
          reason: "device-ownership-mismatch",
        });
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "node rename denied"));
        return;
      }
      const trimmed = displayName.trim();
      if (!trimmed) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "displayName required"));
        return;
      }
      const updated = await renamePairedNode(nodeId, trimmed);
      if (!updated) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown nodeId"));
        return;
      }
      respond(true, { nodeId: updated.nodeId, displayName: updated.displayName }, undefined);
    });
  },
};
