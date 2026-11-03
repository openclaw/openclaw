import type { ApplicationGatewaySnapshot } from "../../app/gateway.ts";
import { canPresentGatewayMethod } from "../gateway-methods.ts";

/** Owned Beam viewing never broadens the connection's shared-catalog scopes. */
export function catalogReadMethod(
  snapshot: Pick<ApplicationGatewaySnapshot, "hello">,
  catalogId: string,
  operation: "list" | "read",
): string {
  return catalogId === "beam" &&
    snapshot.hello?.auth &&
    !canPresentGatewayMethod(snapshot, "sessions.catalog.read", "operator.read", {
      requireAdvertisement: false,
    })
    ? `beam.owned.${operation}`
    : `sessions.catalog.${operation}`;
}
