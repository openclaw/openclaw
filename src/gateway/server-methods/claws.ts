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
import type { GatewayRequestHandlers, RespondFn } from "./types.js";
import { assertValidParams } from "./validation.js";

const log = createSubsystemLogger("gateway/claws");

function respondClawHubError(error: unknown, respond: RespondFn): void {
  if (error instanceof ClawsLabsDisabledError) {
    respond(false, undefined, errorShape(ErrorCodes.FORBIDDEN, error.message));
    return;
  }
  const message =
    error instanceof ClawHubSourceError ? error.message : "ClawHub catalog is unavailable.";
  log.error(
    `ClawHub Claw request failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, message));
}

export const clawsHandlers: GatewayRequestHandlers = {
  "claws.catalog.search": async ({ params, respond, context }) => {
    if (
      !assertValidParams(params, validateClawsCatalogSearchParams, "claws.catalog.search", respond)
    ) {
      return;
    }
    try {
      assertClawsLabsEnabled(context.getRuntimeConfig());
      const entries = params.query?.trim()
        ? await searchClawHubClaws({
            query: params.query,
            ...(params.limit ? { limit: params.limit } : {}),
          })
        : await listClawHubClaws();
      assertClawsLabsEnabled(context.getRuntimeConfig());
      respond(true, { entries: entries.slice(0, params.limit ?? entries.length) });
    } catch (error) {
      respondClawHubError(error, respond);
    }
  },
  "claws.catalog.detail": async ({ params, respond, context }) => {
    if (
      !assertValidParams(params, validateClawsCatalogDetailParams, "claws.catalog.detail", respond)
    ) {
      return;
    }
    try {
      assertClawsLabsEnabled(context.getRuntimeConfig());
      const detail = await readClawHubClawDetail(params);
      assertClawsLabsEnabled(context.getRuntimeConfig());
      respond(true, { detail });
    } catch (error) {
      respondClawHubError(error, respond);
    }
  },
  "claws.catalog.preview": async ({ params, respond, context }) => {
    if (
      !assertValidParams(
        params,
        validateClawsCatalogPreviewParams,
        "claws.catalog.preview",
        respond,
      )
    ) {
      return;
    }
    try {
      assertClawsLabsEnabled(context.getRuntimeConfig());
      const preview = await readClawHubClawPreview(params);
      assertClawsLabsEnabled(context.getRuntimeConfig());
      respond(true, { preview });
    } catch (error) {
      respondClawHubError(error, respond);
    }
  },
};
