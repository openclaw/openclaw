import { canCallGatewayMethod } from "../lib/gateway-methods.ts";
import type { ApplicationGatewaySnapshot } from "./gateway.ts";

export type WebPushAccess = {
  canManage: boolean;
  canReadPreferences: boolean;
};

export function readWebPushAccess(snapshot: ApplicationGatewaySnapshot): WebPushAccess {
  // Push methods are bundled with the UI; subscription methods are intentionally
  // unadvertised. Their current operator scopes, not catalog presence, admit use.
  return {
    canManage: canCallGatewayMethod(snapshot, "push.web.subscribe", "operator.write", {
      requireAdvertisement: false,
    }),
    canReadPreferences: canCallGatewayMethod(
      snapshot,
      "push.web.preferences.get",
      "operator.read",
      {
        requireAdvertisement: false,
      },
    ),
  };
}
