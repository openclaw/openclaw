import type { DeviceAuthToken } from "../../infra/device-pairing.js";
import type { GatewayClient } from "./types.js";

export type DeviceSessionAuthz = {
  callerDeviceId: string | null;
  callerScopes: string[];
  isAdminCaller: boolean;
};

export type DeviceManagementAuthz = DeviceSessionAuthz & {
  normalizedTargetDeviceId: string;
};

export function resolveDeviceSessionAuthz(client: GatewayClient | null): DeviceSessionAuthz {
  const callerScopes = Array.isArray(client?.connect?.scopes) ? client.connect.scopes : [];
  const rawCallerDeviceId = client?.connect?.device?.id;
  const callerDeviceId =
    client?.isDeviceTokenAuth && typeof rawCallerDeviceId === "string" && rawCallerDeviceId.trim()
      ? rawCallerDeviceId.trim()
      : null;
  return {
    callerDeviceId,
    callerScopes,
    isAdminCaller: callerScopes.includes("operator.admin"),
  };
}

export function resolveDeviceManagementAuthz(
  client: GatewayClient | null,
  targetDeviceId: string,
): DeviceManagementAuthz {
  return {
    ...resolveDeviceSessionAuthz(client),
    normalizedTargetDeviceId: targetDeviceId.trim(),
  };
}

export function deniesCrossDeviceManagement(authz: DeviceManagementAuthz): boolean {
  return Boolean(
    authz.callerDeviceId &&
    authz.callerDeviceId !== authz.normalizedTargetDeviceId &&
    !authz.isAdminCaller,
  );
}

export function deniesDeviceTokenRoleManagement(
  authz: DeviceManagementAuthz,
  targetRole: string,
): boolean {
  return !authz.isAdminCaller && requestsNonOperatorDeviceRole({ role: targetRole });
}

export function requestsNonOperatorDeviceRole(input: { role?: string; roles?: string[] }): boolean {
  return [input.role, ...(input.roles ?? [])].some((role) => {
    const normalized = role?.trim();
    return Boolean(normalized && normalized !== "operator");
  });
}

export function resolveDevicePairingApprovalDenial(
  authz: Pick<DeviceSessionAuthz, "callerDeviceId" | "isAdminCaller">,
  pending: { deviceId: string; role?: string; roles?: string[] },
): "device-ownership-mismatch" | "role-management-requires-admin" | undefined {
  if (authz.isAdminCaller) {
    return undefined;
  }
  if (authz.callerDeviceId && pending.deviceId.trim() !== authz.callerDeviceId) {
    return "device-ownership-mismatch";
  }
  return requestsNonOperatorDeviceRole(pending) ? "role-management-requires-admin" : undefined;
}

function hasNonOperatorDeviceTokenRole(
  tokens: Record<string, DeviceAuthToken> | undefined,
): boolean {
  for (const token of Object.values(tokens ?? {})) {
    const normalized = token.role.trim();
    if (normalized && normalized !== "operator") {
      return true;
    }
  }
  return false;
}

export function pairedDeviceHasNonOperatorRole(device: {
  role?: string;
  roles?: string[];
  tokens?: Record<string, DeviceAuthToken>;
}): boolean {
  return requestsNonOperatorDeviceRole(device) || hasNonOperatorDeviceTokenRole(device.tokens);
}
