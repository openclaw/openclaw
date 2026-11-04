import type { ApplicationGatewaySnapshot } from "../../app/gateway.ts";
import { canPresentGatewayMethod } from "../gateway-methods.ts";

/** Owned Beam access never broadens the connection's shared-catalog scopes. */
export function catalogMethod(
  snapshot: Pick<ApplicationGatewaySnapshot, "hello">,
  catalogId: string,
  operation: "list" | "read" | "continue",
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

/** Owned-source composition is admitted by its narrow method, not by shared catalog scopes. */
export function canComposeCatalogSession(
  snapshot: Pick<ApplicationGatewaySnapshot, "hello">,
  catalogId: string,
): boolean {
  const method = catalogMethod(snapshot, catalogId, "continue");
  const ownedContinuation = method === "beam.owned.continue";
  return canPresentGatewayMethod(
    snapshot,
    method,
    ownedContinuation ? "operator.sessions.write" : "operator.write",
    { requireAdvertisement: ownedContinuation },
  );
}
