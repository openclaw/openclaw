import {
  approveDevicePairing,
  getPairedDevice,
  listDevicePairing,
  removePairedDevice,
  type DeviceAuthToken,
  type RotateDeviceTokenDenyReason,
  rejectDevicePairing,
  revokeDeviceToken,
  rotateDeviceToken,
  summarizeDeviceTokens,
} from "../../infra/device-pairing.js";
import { normalizeDeviceAuthScopes } from "../../shared/device-auth.js";
import { resolveMissingRequestedScope } from "../../shared/operator-scope-compat.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateDevicePairApproveParams,
  validateDevicePairListParams,
  validateDevicePairRemoveParams,
  validateDevicePairRejectParams,
  validateDeviceTokenRevokeParams,
  validateDeviceTokenRotateParams,
} from "../protocol/index.js";
import { invalidateNodeListCache } from "./nodes.js";
import type { GatewayRequestHandlers } from "./types.js";

const DEVICE_TOKEN_ROTATION_DENIED_MESSAGE = "device token rotation denied";

function redactPairedDevice(
  device: { tokens?: Record<string, DeviceAuthToken> } & Record<string, unknown>,
) {
  const { tokens, approvedScopes: _approvedScopes, ...rest } = device;
  return {
    ...rest,
    tokens: summarizeDeviceTokens(tokens),
  };
}

function logDeviceTokenRotationDenied(params: {
  log: { warn: (message: string) => void };
  deviceId: string;
  role: string;
  reason: RotateDeviceTokenDenyReason | "caller-missing-scope" | "unknown-device-or-role";
  scope?: string | null;
}) {
  const suffix = params.scope ? ` scope=${params.scope}` : "";
  params.log.warn(
    `device token rotation denied device=${params.deviceId} role=${params.role} reason=${params.reason}${suffix}`,
  );
}

export const deviceHandlers: GatewayRequestHandlers = {
  "device.pair.list": async ({ params, respond }) => {
    if (!validateDevicePairListParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid device.pair.list params: ${formatValidationErrors(
            validateDevicePairListParams.errors,
          )}`,
        ),
      );
      return;
    }
    const list = await listDevicePairing();
    respond(
      true,
      {
        pending: list.pending,
        paired: list.paired.map((device) => redactPairedDevice(device)),
      },
      undefined,
    );
  },
  "device.pair.approve": async ({ params, respond, context, client }) => {
    if (!validateDevicePairApproveParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid device.pair.approve params: ${formatValidationErrors(
            validateDevicePairApproveParams.errors,
          )}`,
        ),
      );
      return;
    }
    const { requestId } = params as { requestId: string };
    const callerScopes = Array.isArray(client?.connect?.scopes) ? client.connect.scopes : [];
    const approved = await approveDevicePairing(requestId, { callerScopes });
    if (!approved) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown requestId"));
      return;
    }
    if (approved.status === "forbidden") {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `missing scope: ${approved.missingScope}`),
      );
      return;
    }
    context.logGateway.info(
      `device pairing approved device=${approved.device.deviceId} role=${approved.device.role ?? "unknown"}`,
    );
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
    invalidateNodeListCache();
    respond(true, { requestId, device: redactPairedDevice(approved.device) }, undefined);
  },
  "device.pair.reject": async ({ params, respond, context }) => {
    if (!validateDevicePairRejectParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid device.pair.reject params: ${formatValidationErrors(
            validateDevicePairRejectParams.errors,
          )}`,
        ),
      );
      return;
    }
    const { requestId } = params as { requestId: string };
    const rejected = await rejectDevicePairing(requestId);
    if (!rejected) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown requestId"));
      return;
    }
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
    invalidateNodeListCache();
    respond(true, rejected, undefined);
  },
  "device.pair.remove": async ({ params, respond, context }) => {
    if (!validateDevicePairRemoveParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid device.pair.remove params: ${formatValidationErrors(
            validateDevicePairRemoveParams.errors,
          )}`,
        ),
      );
      return;
    }
    const { deviceId } = params as { deviceId: string };
    const removed = await removePairedDevice(deviceId);
    if (!removed) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown deviceId"));
      return;
    }
    context.logGateway.info(`device pairing removed device=${removed.deviceId}`);
    invalidateNodeListCache();
    respond(true, removed, undefined);
  },
  "device.token.rotate": async ({ params, respond, context, client }) => {
    if (!validateDeviceTokenRotateParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid device.token.rotate params: ${formatValidationErrors(
            validateDeviceTokenRotateParams.errors,
          )}`,
        ),
      );
      return;
    }
    const { deviceId, role, scopes } = params as {
      deviceId: string;
      role: string;
      scopes?: string[];
    };
    const pairedDevice = await getPairedDevice(deviceId);
    if (!pairedDevice) {
      logDeviceTokenRotationDenied({
        log: context.logGateway,
        deviceId,
        role,
        reason: "unknown-device-or-role",
      });
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, DEVICE_TOKEN_ROTATION_DENIED_MESSAGE),
      );
      return;
    }
    const callerScopes = Array.isArray(client?.connect?.scopes) ? client.connect.scopes : [];
    const requestedScopes = normalizeDeviceAuthScopes(
      scopes ?? pairedDevice.tokens?.[role.trim()]?.scopes ?? pairedDevice.scopes,
    );
    const missingScope = resolveMissingRequestedScope({
      role,
      requestedScopes,
      allowedScopes: callerScopes,
    });
    if (missingScope) {
      logDeviceTokenRotationDenied({
        log: context.logGateway,
        deviceId,
        role,
        reason: "caller-missing-scope",
        scope: missingScope,
      });
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, DEVICE_TOKEN_ROTATION_DENIED_MESSAGE),
      );
      return;
    }
    const rotated = await rotateDeviceToken({ deviceId, role, scopes });
    if (!rotated.ok) {
      logDeviceTokenRotationDenied({
        log: context.logGateway,
        deviceId,
        role,
        reason: rotated.reason,
      });
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, DEVICE_TOKEN_ROTATION_DENIED_MESSAGE),
      );
      return;
    }
    const entry = rotated.entry;
    context.logGateway.info(
      `device token rotated device=${deviceId} role=${entry.role} scopes=${entry.scopes.join(",")}`,
    );
    respond(
      true,
      {
        deviceId,
        role: entry.role,
        token: entry.token,
        scopes: entry.scopes,
        rotatedAtMs: entry.rotatedAtMs ?? entry.createdAtMs,
      },
      undefined,
    );
  },
  "device.token.revoke": async ({ params, respond, context }) => {
    if (!validateDeviceTokenRevokeParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid device.token.revoke params: ${formatValidationErrors(
            validateDeviceTokenRevokeParams.errors,
          )}`,
        ),
      );
      return;
    }
    const { deviceId, role } = params as { deviceId: string; role: string };
    const entry = await revokeDeviceToken({ deviceId, role });
    if (!entry) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown deviceId/role"));
      return;
    }
    context.logGateway.info(`device token revoked device=${deviceId} role=${entry.role}`);
    respond(
      true,
      { deviceId, role: entry.role, revokedAtMs: entry.revokedAtMs ?? Date.now() },
      undefined,
    );
  },
};
