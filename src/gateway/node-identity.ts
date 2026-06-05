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
  options?: { trustInstanceId?: boolean },
): string | null {
  const resolvedNodeId = normalizeTrimmedString(params?.nodeIdentity?.nodeId);
  if (resolvedNodeId) {
    return resolvedNodeId;
  }
  const connect = params?.connect;
  // Keep every node-facing gateway path on the same identity contract:
  // signed CLI --node-id arrives as client.instanceId and wins before device/client fallbacks.
  // v4 signed instanceId is only used when trustInstanceId (set for role="node" device-auth v4).
  if (options?.trustInstanceId !== false) {
    const instanceId = normalizeTrimmedString(connect?.client?.instanceId);
    if (instanceId) {
      return instanceId;
    }
  }
  const deviceId = normalizeTrimmedString(connect?.device?.id);
  if (deviceId) {
    return deviceId;
  }
  return normalizeTrimmedString(connect?.client?.id) || null;
}
