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
  const callerScopes = client?.connect.scopes ?? [];
  const callerDeviceId = client?.isDeviceTokenAuth
    ? client.connect.device?.id.trim() || null
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

export function pairedDeviceHasNonOperatorRole(device: {
  role?: string;
  roles?: string[];
  tokens?: Record<string, DeviceAuthToken>;
}): boolean {
  return (
    requestsNonOperatorDeviceRole(device) ||
    Object.values(device.tokens ?? {}).some((token) => {
      const normalized = token.role.trim();
      return Boolean(normalized && normalized !== "operator");
    })
  );
}
