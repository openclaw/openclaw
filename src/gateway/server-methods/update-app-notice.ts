import { GATEWAY_CLIENT_IDS } from "../../../packages/gateway-protocol/src/client-info.js";
import type { UpdateRunRecord } from "../../infra/update-run-record.js";
import { isInternalMessageChannel } from "../../utils/message-channel.js";
import { GATEWAY_EVENT_UPDATE_RUN_CHANGED } from "../events.js";
import { readOperatorToolRunAuthority } from "../operator-invocation-authority.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

/** Internal app requests surface through the durable run instead of writing a chat notice. */
export function appUpdateNoticePublisher(
  { client, context }: GatewayRequestHandlerOptions,
  requesterChannel: string | undefined,
) {
  if (!isInternalMessageChannel(requesterChannel)) {
    return undefined;
  }
  const clientId =
    client?.internal?.operatorRunAuthority?.clientId ??
    readOperatorToolRunAuthority()?.clientId ??
    (!client?.internal?.syntheticClient ? client?.connect.client.id : undefined);
  if (
    clientId !== GATEWAY_CLIENT_IDS.CONTROL_UI &&
    clientId !== GATEWAY_CLIENT_IDS.MACOS_APP &&
    clientId !== GATEWAY_CLIENT_IDS.LINUX_APP
  ) {
    return undefined;
  }
  // Brief terminal refusals can settle before the update watcher samples the active ledger.
  return ({ runId, phase, status, updatedAtMs }: UpdateRunRecord) =>
    context.broadcast?.(GATEWAY_EVENT_UPDATE_RUN_CHANGED, { runId, phase, status, updatedAtMs });
}
