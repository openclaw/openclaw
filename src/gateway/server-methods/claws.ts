import {
  ErrorCodes,
  errorShape,
  validateClawsCatalogDetailParams,
  validateClawsCatalogPreviewParams,
  validateClawsCatalogSearchParams,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  ClawHubSourceError,
  listClawHubClaws,
  readClawHubClawDetail,
  readClawHubClawPreview,
  searchClawHubClaws,
} from "../../claws/clawhub-source.js";
import { assertClawsLabsEnabled, ClawsLabsDisabledError } from "../../claws/labs-gate.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { GatewayRequestHandlers } from "./types.js";
import { defineValidatedGatewayHandler } from "./validation.js";

const log = createSubsystemLogger("gateway/claws");

function mapClawHubError(error: unknown) {
  if (error instanceof ClawsLabsDisabledError) {
    return errorShape(ErrorCodes.FORBIDDEN, error.message);
  }
  const message =
    error instanceof ClawHubSourceError ? error.message : "ClawHub catalog is unavailable.";
  log.error(
    `ClawHub Claw request failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  return errorShape(ErrorCodes.UNAVAILABLE, message);
}

export const clawsHandlers: GatewayRequestHandlers = {
  "claws.catalog.search": defineValidatedGatewayHandler(
    "claws.catalog.search",
    validateClawsCatalogSearchParams,
    async ({ params, respond, context }) => {
      assertClawsLabsEnabled(context.getRuntimeConfig());
      const entries = params.query?.trim()
        ? await searchClawHubClaws({
            query: params.query,
            ...(params.category ? { category: params.category } : {}),
            ...(params.limit ? { limit: params.limit } : {}),
          })
        : await listClawHubClaws({
            ...(params.category ? { category: params.category } : {}),
            ...(params.featured ? { featured: true } : {}),
          });
      assertClawsLabsEnabled(context.getRuntimeConfig());
      respond(true, { entries: entries.slice(0, params.limit ?? entries.length) });
    },
    mapClawHubError,
  ),
  "claws.catalog.detail": defineValidatedGatewayHandler(
    "claws.catalog.detail",
    validateClawsCatalogDetailParams,
    async ({ params, respond, context }) => {
      assertClawsLabsEnabled(context.getRuntimeConfig());
      const detail = await readClawHubClawDetail(params);
      assertClawsLabsEnabled(context.getRuntimeConfig());
      respond(true, { detail });
    },
    mapClawHubError,
  ),
  "claws.catalog.preview": defineValidatedGatewayHandler(
    "claws.catalog.preview",
    validateClawsCatalogPreviewParams,
    async ({ params, respond, context }) => {
      assertClawsLabsEnabled(context.getRuntimeConfig());
      const preview = await readClawHubClawPreview(params);
      assertClawsLabsEnabled(context.getRuntimeConfig());
      respond(true, { preview });
    },
    mapClawHubError,
  ),
};
