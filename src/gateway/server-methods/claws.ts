import {
  ErrorCodes,
  errorShape,
  validateClawsCatalogDetailParams,
  validateClawsCatalogSearchParams,
  validateClawsStatusParams,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  ClawHubSourceError,
  listClawHubClaws,
  readClawHubClawDetail,
  searchClawHubClaws,
} from "../../claws/clawhub-source.js";
import { readClawStatusForGateway } from "../../claws/gateway-status-worker.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { GatewayRequestHandlers, RespondFn } from "./types.js";
import { assertValidParams } from "./validation.js";

const log = createSubsystemLogger("gateway/claws");

function respondClawHubError(error: unknown, respond: RespondFn): void {
  const message =
    error instanceof ClawHubSourceError ? error.message : "ClawHub catalog is unavailable.";
  log.error(
    `ClawHub Claw request failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, message));
}

export const clawsHandlers: GatewayRequestHandlers = {
  "claws.catalog.search": async ({ params, respond }) => {
    if (
      !assertValidParams(params, validateClawsCatalogSearchParams, "claws.catalog.search", respond)
    ) {
      return;
    }
    try {
      const entries = params.query?.trim()
        ? await searchClawHubClaws({
            query: params.query,
            ...(params.limit ? { limit: params.limit } : {}),
          })
        : await listClawHubClaws();
      respond(true, { entries: entries.slice(0, params.limit ?? entries.length) });
    } catch (error) {
      respondClawHubError(error, respond);
    }
  },
  "claws.catalog.detail": async ({ params, respond }) => {
    if (
      !assertValidParams(params, validateClawsCatalogDetailParams, "claws.catalog.detail", respond)
    ) {
      return;
    }
    try {
      const detail = await readClawHubClawDetail(params);
      respond(true, { detail });
    } catch (error) {
      respondClawHubError(error, respond);
    }
  },
  "claws.status": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateClawsStatusParams, "claws.status", respond)) {
      return;
    }
    try {
      const target = typeof params?.target === "string" ? params.target : undefined;
      const status = await readClawStatusForGateway({
        config: context.getRuntimeConfig(),
        target,
        listCronJobs: () => context.cron.list({ includeDisabled: true }),
      });
      respond(true, status);
    } catch (error) {
      log.error(`claws.status failed: ${error instanceof Error ? error.message : String(error)}`);
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "Claw status is unavailable. Review Gateway logs."),
      );
    }
  },
};
