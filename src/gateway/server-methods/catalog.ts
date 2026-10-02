import {
  ErrorCodes,
  errorShape,
  validateCatalogBrowseParams,
  validateCatalogSearchKeywordsParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  browseClawHubCatalog,
  CatalogDiscoveryRequestError,
  searchClawHubCatalogKeywords,
} from "../../plugins/catalog-discovery.js";
import { resolveSkillsAgentWorkspace } from "./skills-workspace-handler.js";
import type { GatewayRequestHandlers } from "./types.js";
import { defineValidatedGatewayHandler } from "./validation.js";

function catalogError(error: unknown) {
  return errorShape(
    error instanceof CatalogDiscoveryRequestError
      ? ErrorCodes.INVALID_REQUEST
      : ErrorCodes.UNAVAILABLE,
    formatErrorMessage(error),
  );
}

export const catalogHandlers: GatewayRequestHandlers = {
  "catalog.browse": defineValidatedGatewayHandler(
    "catalog.browse",
    validateCatalogBrowseParams,
    async ({ params, respond, context }) => {
      if (params.query?.trim() && (params.cursor || params.feed === "trending")) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "Catalog search does not accept a cursor or trending feed.",
          ),
        );
        return;
      }
      try {
        const workspace =
          params.kind === "skill" ? resolveSkillsAgentWorkspace(params, context) : undefined;
        if (workspace && !workspace.ok) {
          respond(false, undefined, workspace.error);
          return;
        }
        const result = await browseClawHubCatalog({
          request: params,
          config: context.getRuntimeConfig(),
          ...(workspace
            ? { agentId: workspace.agentId, workspaceDir: workspace.workspaceDir }
            : {}),
        });
        respond(true, result, undefined);
      } catch (error) {
        respond(false, undefined, catalogError(error));
      }
    },
  ),
  "catalog.searchKeywords": defineValidatedGatewayHandler(
    "catalog.searchKeywords",
    validateCatalogSearchKeywordsParams,
    async ({ params, respond, context }) => {
      try {
        const workspace =
          !params.kinds || params.kinds.includes("skill")
            ? resolveSkillsAgentWorkspace(params, context)
            : undefined;
        if (workspace && !workspace.ok) {
          respond(false, undefined, workspace.error);
          return;
        }
        const result = await searchClawHubCatalogKeywords({
          request: params,
          config: context.getRuntimeConfig(),
          ...(workspace
            ? { agentId: workspace.agentId, workspaceDir: workspace.workspaceDir }
            : {}),
        });
        respond(true, result, undefined);
      } catch (error) {
        respond(false, undefined, catalogError(error));
      }
    },
  ),
};
