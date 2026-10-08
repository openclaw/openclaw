import {
  ErrorCodes,
  errorShape,
  type DeviceTokenRotateParams,
  validateDevicePairApproveParams,
  validateDevicePairListParams,
  validateDevicePairRemoveParams,
  validateDevicePairRejectParams,
  validateDevicePairRenameParams,
  validateDeviceTokenRevokeParams,
  validateDeviceTokenRotateParams,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  approveDevicePairing,
  formatDevicePairingForbiddenMessage,
} from "../../infra/device-pairing-approval.js";
import {
  type RevokeDeviceTokenDenyReason,
  type RotateDeviceTokenDenyReason,
  revokeDeviceToken,
  rotateDeviceToken,
  summarizeDeviceTokens,
} from "../../infra/device-pairing-tokens.js";
import {
  getPairedDevice,
  getPendingDevicePairing,
  listDevicePairing,
  removePairedDevice,
  type PairedDevice,
  rejectDevicePairing,
  updatePairedDeviceMetadata,
} from "../../infra/device-pairing.js";
import type { DiagnosticSecurityEventInput } from "../../infra/diagnostic-events.js";
import type {
  DevicePairingList,
  PairedDevice as RedactedPairedDevice,
} from "../device-pairing-list.types.js";
import { reconcileRevokedDeviceWorker } from "../device-worker-revocation.js";
import { GATEWAY_EVENT_DEVICE_PAIR_CHANGED } from "../events.js";
import { clearRemovedNodeRuntimeState } from "../node-runtime-state.js";
import { invalidateNodeWakeState } from "../node-wake-state.js";
import { holdGatewayPolicyResponse } from "../server/ws-policy-close.js";
import {
  deniesCrossDeviceManagement,
  deniesDeviceTokenRoleManagement,
  pairedDeviceHasNonOperatorRole,
  requestsNonOperatorDeviceRole,
  resolveDeviceManagementAuthz,
  resolveDeviceSessionAuthz,
} from "./device-management-authz.js";
import type { DeviceManagementAuthz, DeviceSessionAuthz } from "./device-management-authz.js";
import { emitDeviceManagementSecurityEvent } from "./device-management-security.js";
import { scopeUpgradeHandlers } from "./device-scope-upgrade.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  GatewayRequestHandlers,
  GatewayRequestHandlerOptions,
  RespondFn,
} from "./types.js";
import { assertValidParams } from "./validation.js";

function redactPairedDevice(device: PairedDevice, connected?: boolean): RedactedPairedDevice {
  // Pairing lists are visible to operators; expose token lifecycle metadata
  // without returning raw token material or the internal approved-scope set.
  const { tokens, approvedScopes: _approvedScopes, ...rest } = device;
  return {
    ...rest,
    ...(connected !== undefined ? { connected } : {}),
    tokens: summarizeDeviceTokens(tokens),
  };
}

function prepareDeviceTokenMutation(
  operation: "rotate" | "revoke",
  params: DeviceTokenRotateParams,
  options: Pick<GatewayRequestHandlerOptions, "client" | "context" | "respond">,
) {
  const { deviceId, role } = params;
  const { client, context, respond } = options;
  const authz = resolveDeviceManagementAuthz(client, deviceId);
  const deny = (
    reason:
      | RotateDeviceTokenDenyReason
      | RevokeDeviceTokenDenyReason
      | "device-ownership-mismatch"
      | "role-management-requires-admin",
    scope?: string | null,
  ) => {
    const noun = operation === "rotate" ? "rotation" : "revocation";
    const message = `device token ${noun} denied`;
    const suffix = scope ? ` scope=${scope}` : "";
    context.logGateway.warn(`${message} device=${deviceId} role=${role} reason=${reason}${suffix}`);
    emitDeviceManagementSecurityEvent({
      outcome: "denied",
      severity: "medium",
      policyId: "gateway.device-token",
      decision: "deny",
      action: `device.token.${noun}_denied`,
      authz,
      targetDeviceId: deviceId,
      controlId: `device.token.${operation}`,
      reason,
      attributes: { role: role.trim() },
    });
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, message));
  };
  const denial = deniesCrossDeviceManagement(authz)
    ? "device-ownership-mismatch"
    : deniesDeviceTokenRoleManagement(authz, role)
      ? "role-management-requires-admin"
      : undefined;
  if (denial) {
    deny(denial);
    return undefined;
  }
  // Other roles passed the admin guard; only operator tokens inherit the caller's scope cap.
  const callerScopes = role.trim() === "operator" ? authz.callerScopes : undefined;
  return { authz, callerScopes, deny };
}

async function runDevicePairingMutation(params: {
  operation: "remove" | "rename";
  client: GatewayClient | null;
  context: Pick<GatewayRequestContext, "logGateway">;
  respond: RespondFn;
  deviceId: string;
  run: (authz: DeviceManagementAuthz) => Promise<void>;
}): Promise<void> {
  const authz = resolveDeviceManagementAuthz(params.client, params.deviceId);
  let reason: string | undefined;
  if (deniesCrossDeviceManagement(authz)) {
    reason = "device-ownership-mismatch";
  } else if (authz.callerDeviceId && !authz.isAdminCaller) {
    const paired = await getPairedDevice(authz.normalizedTargetDeviceId);
    if (paired && pairedDeviceHasNonOperatorRole(paired)) {
      reason = "role-management-requires-admin";
    }
  }
  if (!reason) {
    return params.run(authz);
  }
  const operation = params.operation === "remove" ? "removal" : "rename";
  const message = `device pairing ${operation} denied`;
  params.context.logGateway.warn(`${message} device=${params.deviceId} reason=${reason}`);
  emitDevicePairingDeniedSecurityEvent({
    authz,
    targetDeviceId: params.deviceId,
    controlId: `device.pair.${params.operation}`,
    reason,
  });
  params.respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, message));
}

function emitDevicePairingDeniedSecurityEvent(params: {
  authz: DeviceSessionAuthz;
  targetDeviceId?: string;
  controlId: string;
  reason: string;
  severity?: DiagnosticSecurityEventInput["severity"];
}) {
  emitDeviceManagementSecurityEvent({
    action: "device.pairing.denied",
    outcome: "denied",
    severity: params.severity ?? "medium",
    authz: params.authz,
    targetDeviceId: params.targetDeviceId,
    policyId: "gateway.device-pairing",
    decision: "deny",
    controlId: params.controlId,
    reason: params.reason,
  });
}

function authorizePairingDecision(
  operation: "approve" | "reject",
  requestId: string,
  pending: Awaited<ReturnType<typeof getPendingDevicePairing>>,
  authz: DeviceSessionAuthz,
  { respond, context }: Pick<GatewayRequestHandlerOptions, "respond" | "context">,
): boolean {
  const reason = pending
    ? authz.callerDeviceId && pending.deviceId.trim() !== authz.callerDeviceId
      ? "device-ownership-mismatch"
      : operation === "approve" && requestsNonOperatorDeviceRole(pending)
        ? "role-management-requires-admin"
        : undefined
    : undefined;
  if (pending && !reason) {
    return true;
  }
  const decision = operation === "approve" ? "approval" : "rejection";
  const message = `device pairing ${decision} denied`;
  if (pending && reason) {
    context.logGateway.warn(`${message} request=${requestId} reason=${reason}`);
    emitDevicePairingDeniedSecurityEvent({
      authz,
      targetDeviceId: pending.deviceId,
      controlId: `device.pair.${operation}`,
      reason,
    });
  }
  respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, message));
  return false;
}

function emitDevicePairingLifecycleSecurityEvent(params: {
  action:
    | "device.pairing.approved"
    | "device.pairing.rejected"
    | "device.pairing.removed"
    | "device.pairing.renamed";
  severity: DiagnosticSecurityEventInput["severity"];
  authz: DeviceSessionAuthz;
  targetDeviceId: string;
  controlId: string;
  attributes?: Record<string, string | number | boolean>;
}) {
  emitDeviceManagementSecurityEvent({
    ...params,
    outcome: "success",
    policyId: "gateway.device-pairing",
    decision: "allow",
  });
}

function emitDeviceTokenLifecycleSecurityEvent(params: {
  action: "device.token.rotated" | "device.token.revoked";
  severity: DiagnosticSecurityEventInput["severity"];
  authz: DeviceSessionAuthz;
  targetDeviceId: string;
  controlId: string;
  role: string;
  scopeCount?: number;
}) {
  emitDeviceManagementSecurityEvent({
    ...params,
    outcome: "success",
    policyId: "gateway.device-token",
    decision: "allow",
    attributes: {
      role: params.role,
      ...(params.scopeCount !== undefined ? { scope_count: params.scopeCount } : {}),
    },
  });
}

export const deviceHandlers: GatewayRequestHandlers = {
  ...scopeUpgradeHandlers,
  "device.pair.list": async ({ params, respond, context, client }) => {
    if (!assertValidParams(params, validateDevicePairListParams, "device.pair.list", respond)) {
      return;
    }
    const list = await listDevicePairing();
    const authz = resolveDeviceSessionAuthz(client);
    let visibleList = list;
    if (authz.callerDeviceId && !authz.isAdminCaller) {
      visibleList = {
        pending: list.pending.filter((request) => request.deviceId.trim() === authz.callerDeviceId),
        paired: list.paired.filter((device) => device.deviceId.trim() === authz.callerDeviceId),
      };
    }
    respond(
      true,
      {
        pending: visibleList.pending,
        // Live-connection state lets clients distinguish active pairings from
        // stale ones; node-role links alone do not cover operator clients.
        paired: visibleList.paired.map((device) =>
          redactPairedDevice(
            device,
            context.hasConnectedClientsForDevice?.(device.deviceId.trim()) ?? false,
          ),
        ),
      } satisfies DevicePairingList,
      undefined,
    );
  },
  "device.pair.approve": async ({ params, respond, context, client }) => {
    if (
      !assertValidParams(params, validateDevicePairApproveParams, "device.pair.approve", respond)
    ) {
      return;
    }
    const requestId = params.requestId.trim();
    const authz = resolveDeviceSessionAuthz(client);
    if (!authz.isAdminCaller) {
      const pending = await getPendingDevicePairing(requestId);
      if (!authorizePairingDecision("approve", requestId, pending, authz, { respond, context })) {
        return;
      }
    }
    const approved = await approveDevicePairing(requestId, { callerScopes: authz.callerScopes });
    if (!approved) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown requestId"));
      return;
    }
    if (approved.status === "forbidden") {
      emitDevicePairingDeniedSecurityEvent({
        authz,
        controlId: "device.pair.approve",
        reason: approved.reason,
      });
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, formatDevicePairingForbiddenMessage(approved)),
      );
      return;
    }
    const normalizedDeviceId = approved.device.deviceId.trim();
    // Operator reapproval leaves the narrow requester live. Wake its identity-bound waiter only
    // after durable token rotation, before any node-generation teardown can run.
    context.scopeUpgradeCoordinator?.notify(requestId, "approved");
    if (approved.nodePairingGenerationChanged) {
      invalidateNodeWakeState(normalizedDeviceId);
      // Mark the retired node generation before publishing success so buffered
      // node RPCs cannot retain authority while transport teardown is deferred.
      context.invalidateClientsForDevice?.(normalizedDeviceId, {
        role: "node",
        reason: "device-pairing-reapproved",
      });
    }
    context.logGateway.info(
      `device pairing approved device=${approved.device.deviceId} role=${approved.device.role ?? "unknown"}`,
    );
    emitDevicePairingLifecycleSecurityEvent({
      action: "device.pairing.approved",
      severity: "low",
      authz,
      targetDeviceId: approved.device.deviceId,
      controlId: "device.pair.approve",
      attributes: {
        role_count: approved.device.roles?.length ?? (approved.device.role ? 1 : 0),
        scope_count: approved.device.approvedScopes?.length ?? approved.device.scopes?.length ?? 0,
      },
    });
    context.broadcast(
      "device.pair.resolved",
      {
        requestId,
        deviceId: approved.device.deviceId,
        decision: "approved",
        ts: Date.now(),
      },
      { dropIfSlow: true },
    );
    respond(true, { requestId, device: redactPairedDevice(approved.device) }, undefined);
    if (approved.nodePairingGenerationChanged) {
      queueMicrotask(() => {
        context.disconnectClientsForDevice?.(normalizedDeviceId, { role: "node" });
      });
    }
  },
  "device.pair.reject": async ({ params, respond, context, client }) => {
    if (!assertValidParams(params, validateDevicePairRejectParams, "device.pair.reject", respond)) {
      return;
    }
    const requestId = params.requestId.trim();
    const authz = resolveDeviceSessionAuthz(client);
    if (authz.callerDeviceId && !authz.isAdminCaller) {
      const pending = await getPendingDevicePairing(requestId);
      if (!authorizePairingDecision("reject", requestId, pending, authz, { respond, context })) {
        return;
      }
    }
    const rejected = await rejectDevicePairing(requestId);
    if (!rejected) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown requestId"));
      return;
    }
    context.scopeUpgradeCoordinator?.notify(requestId, "rejected");
    emitDevicePairingLifecycleSecurityEvent({
      action: "device.pairing.rejected",
      authz,
      targetDeviceId: rejected.deviceId,
      controlId: "device.pair.reject",
      severity: "low",
    });
    context.broadcast(
      "device.pair.resolved",
      {
        requestId,
        deviceId: rejected.deviceId,
        decision: "rejected",
        ts: Date.now(),
      },
      { dropIfSlow: true },
    );
    respond(true, rejected, undefined);
  },
  "device.pair.remove": async ({ params, respond, context, client }) => {
    if (!assertValidParams(params, validateDevicePairRemoveParams, "device.pair.remove", respond)) {
      return;
    }
    const { deviceId } = params;
    await runDevicePairingMutation({
      operation: "remove",
      client,
      context,
      respond,
      deviceId,
      run: async (authz) => {
        const removed = await removePairedDevice(deviceId);
        if (!removed) {
          respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown deviceId"));
          return;
        }
        clearRemovedNodeRuntimeState({ nodeId: removed.deviceId, context });
        // Removal can retire its requester. Keep only its final reply, without
        // letting a failed claim or worker reconciliation skip client teardown.
        try {
          try {
            holdGatewayPolicyResponse(respond);
          } finally {
            context.invalidateClientsForDevice?.(removed.deviceId, {
              reason: "device-pair-removed",
            });
            await reconcileRevokedDeviceWorker(context, removed.deviceId);
          }
          context.logGateway.info(`device pairing removed device=${removed.deviceId}`);
          emitDevicePairingLifecycleSecurityEvent({
            action: "device.pairing.removed",
            severity: "medium",
            authz,
            targetDeviceId: removed.deviceId,
            controlId: "device.pair.remove",
          });
          respond(true, removed, undefined);
        } finally {
          queueMicrotask(() => {
            context.disconnectClientsForDevice?.(removed.deviceId);
          });
        }
      },
    });
  },
  "device.pair.rename": async ({ params, respond, context, client }) => {
    if (!assertValidParams(params, validateDevicePairRenameParams, "device.pair.rename", respond)) {
      return;
    }
    const { deviceId, label } = params;
    const trimmed = label.trim();
    if (!trimmed) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "label required"));
      return;
    }
    await runDevicePairingMutation({
      operation: "rename",
      client,
      context,
      respond,
      deviceId,
      run: async (authz) => {
        const updated = await updatePairedDeviceMetadata(deviceId, { operatorLabel: trimmed });
        if (!updated) {
          respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown deviceId"));
          return;
        }
        context.logGateway.info(`device pairing renamed device=${deviceId} label=${trimmed}`);
        emitDevicePairingLifecycleSecurityEvent({
          action: "device.pairing.renamed",
          severity: "low",
          authz,
          targetDeviceId: deviceId,
          controlId: "device.pair.rename",
        });
        context.broadcast(GATEWAY_EVENT_DEVICE_PAIR_CHANGED, {}, { dropIfSlow: true });
        respond(true, { deviceId, label: trimmed }, undefined);
      },
    });
  },
  "device.token.rotate": async ({ params, respond, context, client }) => {
    if (
      !assertValidParams(params, validateDeviceTokenRotateParams, "device.token.rotate", respond)
    ) {
      return;
    }
    const { deviceId, role, scopes } = params;
    const mutation = prepareDeviceTokenMutation("rotate", params, { client, context, respond });
    if (!mutation) {
      return;
    }
    const { authz, callerScopes, deny } = mutation;
    const result = await rotateDeviceToken({ deviceId, role, scopes, callerScopes });
    if (!result.ok) {
      deny(result.reason, result.scope);
      return;
    }
    const entry = result.entry;
    const normalizedDeviceId = deviceId.trim();
    context.logGateway.info(
      `device token rotated device=${deviceId} role=${entry.role} scopes=${entry.scopes.join(",")}`,
    );
    emitDeviceTokenLifecycleSecurityEvent({
      action: "device.token.rotated",
      severity: "medium",
      authz,
      targetDeviceId: deviceId,
      controlId: "device.token.rotate",
      role: entry.role,
      scopeCount: entry.scopes.length,
    });
    if (entry.role === "node") {
      invalidateNodeWakeState(normalizedDeviceId);
    }
    // Claim after the awaited commit, while the caller is still current. Fence
    // pipelined frames even if the claim fails; close after the synchronous reply.
    try {
      holdGatewayPolicyResponse(respond);
    } finally {
      context.invalidateClientsForDevice?.(normalizedDeviceId, {
        role: entry.role,
        reason: "device-token-rotated",
      });
      queueMicrotask(() => {
        context.disconnectClientsForDevice?.(normalizedDeviceId, { role: entry.role });
      });
    }
    // Record the delivery decision on the wire: an absent token alone cannot tell a
    // client whether the rotation withheld the secret by policy or the response
    // predates this field, and the two need different operator-facing outcomes.
    const deliversTokenInBand = Boolean(
      authz.callerDeviceId && authz.callerDeviceId === authz.normalizedTargetDeviceId,
    );
    respond(
      true,
      {
        deviceId,
        role: entry.role,
        ...(deliversTokenInBand ? { token: entry.token } : {}),
        scopes: entry.scopes,
        rotatedAtMs: entry.rotatedAtMs ?? entry.createdAtMs,
        tokenDelivery: deliversTokenInBand ? "in-band" : "withheld-cross-device",
      },
      undefined,
    );
  },
  "device.token.revoke": async ({ params, respond, context, client }) => {
    if (
      !assertValidParams(params, validateDeviceTokenRevokeParams, "device.token.revoke", respond)
    ) {
      return;
    }
    const { deviceId, role } = params;
    const mutation = prepareDeviceTokenMutation("revoke", params, { client, context, respond });
    if (!mutation) {
      return;
    }
    const { authz, callerScopes, deny } = mutation;
    const result = await revokeDeviceToken({ deviceId, role, callerScopes });
    if (!result.ok) {
      deny(result.reason, result.scope);
      return;
    }
    const entry = result.entry;
    const normalizedDeviceId = deviceId.trim();
    context.logGateway.info(`device token revoked device=${normalizedDeviceId} role=${entry.role}`);
    emitDeviceTokenLifecycleSecurityEvent({
      action: "device.token.revoked",
      severity: "high",
      authz,
      targetDeviceId: normalizedDeviceId,
      controlId: "device.token.revoke",
      role: entry.role,
    });
    // Claim the reply and fence revoked clients before worker cleanup can yield.
    // Cleanup and disconnect remain owned even when that claim fails.
    try {
      try {
        holdGatewayPolicyResponse(respond);
      } finally {
        context.invalidateClientsForDevice?.(normalizedDeviceId, {
          role: entry.role,
          reason: "device-token-revoked",
        });
        if (entry.role === "node") {
          clearRemovedNodeRuntimeState({ nodeId: normalizedDeviceId, context });
          await reconcileRevokedDeviceWorker(context, normalizedDeviceId);
        }
      }
    } finally {
      queueMicrotask(() => {
        context.disconnectClientsForDevice?.(normalizedDeviceId, { role: entry.role });
      });
    }
    respond(
      true,
      {
        deviceId: normalizedDeviceId,
        role: entry.role,
        revokedAtMs: entry.revokedAtMs ?? Date.now(),
      },
      undefined,
    );
  },
};
