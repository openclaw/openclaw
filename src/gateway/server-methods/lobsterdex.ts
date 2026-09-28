import { validateLobsterdexCatalogParams } from "../../../packages/gateway-protocol/src/index.js";
import { listPluginLobsters } from "../../plugins/lobster-catalog.js";
import type { GatewayRequestHandlers } from "./types.js";
import { defineValidatedGatewayMethod } from "./validation.js";

export const lobsterdexHandlers: GatewayRequestHandlers = {
  "lobsterdex.catalog": defineValidatedGatewayMethod(
    "lobsterdex.catalog",
    validateLobsterdexCatalogParams,
    ({ respond }) => {
      respond(true, { entries: listPluginLobsters() });
    },
  ),
};
