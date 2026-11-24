import type { ApplicationGatewaySnapshot } from "../../app/gateway.ts";
import { canPresentGatewayMethod } from "../gateway-methods.ts";

/** Owned Beam access never broadens the connection's shared-catalog scopes. */
export function catalogMethod(
  snapshot: Pick<ApplicationGatewaySnapshot, "hello">,
  catalogId: string,
  operation: "list" | "read" | "resolve" | "continue",
): string {
  const sharedMethod = `sessions.catalog.${operation}`;
  return catalogId === "beam" &&
    snapshot.hello?.auth &&
    !canPresentGatewayMethod(
      snapshot,
      sharedMethod,
      operation === "continue" ? "operator.write" : "operator.read",
      { requireAdvertisement: false },
    )
    ? `beam.owned.${operation}`
    : sharedMethod;
}
