import type { ApplicationGatewaySnapshot } from "../../app/gateway.ts";
import { canPresentGatewayMethod } from "../gateway-methods.ts";

/** Owned Beam access never broadens the connection's shared-catalog scopes. */
export function catalogMethod(
  snapshot: Pick<ApplicationGatewaySnapshot, "hello">,
  catalogId: string,
  operation: "list" | "read" | "continue",
): string {
  return catalogId === "beam" &&
    snapshot.hello?.auth &&
    !canPresentGatewayMethod(
      snapshot,
      `sessions.catalog.${operation}`,
      operation === "continue" ? "operator.write" : "operator.read",
      { requireAdvertisement: false },
    )
    ? `beam.owned.${operation}`
    : `sessions.catalog.${operation}`;
}

/** Owned-source composition is admitted by its narrow method, not by shared catalog scopes. */
export function canComposeCatalogSession(
  snapshot: Pick<ApplicationGatewaySnapshot, "hello">,
  catalogId: string,
): boolean {
  const method = catalogMethod(snapshot, catalogId, "continue");
  return canPresentGatewayMethod(
    snapshot,
    method,
    method === "beam.owned.continue" ? "operator.sessions.write" : "operator.write",
    { requireAdvertisement: method === "beam.owned.continue" },
  );
}
