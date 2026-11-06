import { gatewayOriginScope } from "../../packages/gateway-client/src/gateway-origin-scope.js";
import { loadDeviceAuthTokenReadOnly } from "../infra/device-auth-store.js";
import type { NodeHostGatewayConfig } from "./config.js";
import { formatGatewayCandidateUrl } from "./gateway-candidate-connection.js";

export async function canReuseNodeHostDeviceToken(params: {
  savedGateway?: NodeHostGatewayConfig;
  gatewayCandidates: readonly NodeHostGatewayConfig[];
  deviceId: string;
  env?: NodeJS.ProcessEnv;
}): Promise<boolean> {
  const savedGatewayScope = params.savedGateway
    ? gatewayOriginScope(formatGatewayCandidateUrl(params.savedGateway))
    : undefined;
  return Boolean(
    savedGatewayScope &&
    params.gatewayCandidates.every(
      (candidate) => gatewayOriginScope(formatGatewayCandidateUrl(candidate)) === savedGatewayScope,
    ) &&
    (
      await loadDeviceAuthTokenReadOnly({
        deviceId: params.deviceId,
        role: "node",
        env: params.env ?? process.env,
      })
    )?.token,
  );
}
