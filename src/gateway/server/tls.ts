import type { BridgeTlsConfig } from "../../config/types.gateway.js";
import {
  type BridgeTlsRuntime,
  loadBridgeTlsRuntime,
} from "../../infra/bridge/server/tls.js";

export type GatewayTlsRuntime = BridgeTlsRuntime;

export async function loadGatewayTlsRuntime(
  cfg: BridgeTlsConfig | undefined,
  log?: { info?: (msg: string) => void; warn?: (msg: string) => void },
): Promise<GatewayTlsRuntime> {
  return await loadBridgeTlsRuntime(cfg, log);
}
