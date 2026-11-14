import {
  ErrorCodes,
  errorShape,
  validateTemplatesCatalogDetailParams,
  validateTemplatesCatalogPreviewParams,
  validateTemplatesCatalogSearchParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  ClawHubSourceError,
  listClawHubTemplates,
  readClawHubTemplateDetail,
  readClawHubTemplatePreview,
  searchClawHubTemplates,
} from "../../templates/clawhub-source.js";
import {
  assertTemplatesLabsEnabled,
  TemplatesLabsDisabledError,
} from "../../templates/labs-gate.js";
import type { GatewayRequestHandlers } from "./types.js";
import { defineValidatedGatewayHandler } from "./validation.js";

const log = createSubsystemLogger("gateway/templates");

function mapClawHubError(error: unknown) {
  if (error instanceof TemplatesLabsDisabledError) {
    return errorShape(ErrorCodes.FORBIDDEN, error.message);
  }
  const message =
    error instanceof ClawHubSourceError ? error.message : "ClawHub catalog is unavailable.";
  log.error(
    `ClawHub Template request failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  return errorShape(ErrorCodes.UNAVAILABLE, message);
}

export const templatesHandlers: GatewayRequestHandlers = {
  "templates.catalog.search": defineValidatedGatewayHandler(
    "templates.catalog.search",
    validateTemplatesCatalogSearchParams,
    async ({ params, respond, context }) => {
      assertTemplatesLabsEnabled(context.getRuntimeConfig());
      const entries = params.query?.trim()
        ? await searchClawHubTemplates({
            query: params.query,
            ...(params.category ? { category: params.category } : {}),
            ...(params.limit ? { limit: params.limit } : {}),
          })
        : await listClawHubTemplates({
            ...(params.category ? { category: params.category } : {}),
            ...(params.featured ? { featured: true } : {}),
          });
      assertTemplatesLabsEnabled(context.getRuntimeConfig());
      respond(true, { entries: entries.slice(0, params.limit ?? entries.length) });
    },
    mapClawHubError,
  ),
  "templates.catalog.detail": defineValidatedGatewayHandler(
    "templates.catalog.detail",
    validateTemplatesCatalogDetailParams,
    async ({ params, respond, context }) => {
      assertTemplatesLabsEnabled(context.getRuntimeConfig());
      const detail = await readClawHubTemplateDetail(params);
      assertTemplatesLabsEnabled(context.getRuntimeConfig());
      respond(true, { detail });
    },
    mapClawHubError,
  ),
  "templates.catalog.preview": defineValidatedGatewayHandler(
    "templates.catalog.preview",
    validateTemplatesCatalogPreviewParams,
    async ({ params, respond, context }) => {
      assertTemplatesLabsEnabled(context.getRuntimeConfig());
      const preview = await readClawHubTemplatePreview(params);
      assertTemplatesLabsEnabled(context.getRuntimeConfig());
      respond(true, { preview });
    },
    mapClawHubError,
  ),
};
