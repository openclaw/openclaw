import type { ConnectParams } from "../../packages/gateway-protocol/src/index.js";

type ClientForNodeIdentity = {
  nodeIdentity?: { nodeId?: string | null } | null;
  connect?: Pick<ConnectParams, "client" | "device"> | null;
};

function normalizeTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function resolveNodeIdentityId(
  params: ClientForNodeIdentity | null | undefined,
): string | null {
  const resolvedNodeId = normalizeTrimmedString(params?.nodeIdentity?.nodeId);
  if (resolvedNodeId) {
    return resolvedNodeId;
  }
  const connect = params?.connect;
  // Trust client.instanceId from an already-authenticated device connection
  // (device auth is verified before this resolver is called).
  // CLI --node-id arrives as client.instanceId and takes priority over
  // device id / client id fallbacks.
  const instanceId = normalizeTrimmedString(connect?.client?.instanceId);
  if (instanceId) {
    return instanceId;
  }
  const deviceId = normalizeTrimmedString(connect?.device?.id);
  if (deviceId) {
    return deviceId;
  }
  return normalizeTrimmedString(connect?.client?.id) || null;
}
