import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { MockGatewayControls } from "../test-helpers/control-ui-e2e.ts";

/** Approval upgrades share the subscribe method but do not read initial history. */
export async function getInitialHistoryRequests(gateway: MockGatewayControls, key?: string) {
  return (await gateway.getRequests()).flatMap((request) => {
    const params = asOptionalRecord(request.params);
    const requestedKey =
      request.method === "chat.startup"
        ? params?.sessionKey
        : request.method === "sessions.messages.subscribe" && params?.initialHistory
          ? params.key
          : undefined;
    if (typeof requestedKey !== "string" || (key !== undefined && requestedKey !== key)) {
      return [];
    }
    return [{ ...request, params: { ...params, key: requestedKey } }];
  });
}
