import type { GatewayRequestContext } from "./shared-types.js";

export type GatewayModelCatalogContext = Pick<
  GatewayRequestContext,
  "getRuntimeConfig" | "loadGatewayModelCatalogSnapshot"
> & {
  logGateway: Pick<GatewayRequestContext["logGateway"], "debug">;
};
