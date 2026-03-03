import { isGatewayCliClient } from "../../../utils/message-channel.js";
import type { ConnectParams } from "../../protocol/index.js";

export function resolvePostConnectHealthRefreshOptions(client: ConnectParams["client"]): {
  probe: boolean;
} {
  return { probe: !isGatewayCliClient(client) };
}
